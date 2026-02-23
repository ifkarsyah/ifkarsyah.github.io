---
title: "Elasticsearch Internals Series, Part 6: Aggregations & Analytics"
description: "How aggregations work internally using doc_values, bucket vs metric vs pipeline aggs, cardinality approximation with HyperLogLog++, and building analytics dashboards."
pubDate: 2026-04-06
author: "ifkarsyah"
domain: "Search"
stack: ["Elasticsearch"]
image:
  src: ./es-series.png
  alt: "Elasticsearch Aggregations"
---

Aggregations are Elasticsearch's analytics engine. They let you count documents by category, compute average prices, build time-series histograms, and do nested rollups — all in a single request alongside your search results.

But aggregations don't work like search. They bypass the inverted index entirely and use `doc_values` — the columnar store we covered in Part 3. Understanding this distinction tells you when aggregations are fast and when they're going to cause problems.

## How Aggregations Differ from Search

**Search** uses the inverted index: given a term, find all matching document IDs.

**Aggregations** use `doc_values`: given a set of document IDs, read the field value for each one.

```
Search flow:
  query term → inverted index → matching doc IDs → fetch _source

Aggregation flow:
  matching doc IDs (from query) → doc_values column → compute stats
```

The aggregation happens over the set of documents that matched the query (or all documents if no query). It reads field values sequentially from the columnar `doc_values` store — cache-friendly, fast.

**This is why `text` fields can't be aggregated normally.** `text` fields don't have `doc_values` (they have an inverted index). To aggregate on text, you need a `keyword` sub-field (which does have `doc_values`).

## Three Types of Aggregations

Aggregations fall into three categories:

```
Bucket aggregations        → split documents into groups (like GROUP BY)
  terms, date_histogram, range, filter, nested...

Metric aggregations        → compute a single value from a group
  avg, sum, min, max, stats, percentiles, cardinality...

Pipeline aggregations      → operate on the output of other aggregations
  moving_avg, derivative, cumulative_sum, bucket_sort...
```

They compose: bucket aggs create buckets, metric aggs compute values per bucket, pipeline aggs operate on those values.

## Bucket Aggregations

### `terms` — Group by Field Value

```bash
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "size": 0,
  "aggs": {
    "by_category": {
      "terms": {
        "field": "category",
        "size": 10,
        "order": { "_count": "desc" }
      }
    }
  }
}'
```

Response:
```json
{
  "aggregations": {
    "by_category": {
      "buckets": [
        { "key": "laptops",     "doc_count": 1240 },
        { "key": "peripherals", "doc_count": 876 },
        { "key": "monitors",    "doc_count": 432 }
      ],
      "sum_other_doc_count": 1891    ← documents in categories not shown
    }
  }
}
```

**The `sum_other_doc_count` problem:**

`terms` agg doesn't return all buckets — only the top `size`. The `sum_other_doc_count` tells you how many documents are in the remaining categories.

More importantly: the count in each bucket is an approximation for multi-shard indexes. Each shard computes its own top `size` terms. The coordinating node merges them. A term that's #6 on Shard 0 and #8 on Shard 1 might be #3 globally — but it wasn't returned by either shard.

**Increase `shard_size`** (the per-shard size) to improve accuracy:

```json
"terms": {
  "field": "category",
  "size": 10,
  "shard_size": 100    ← each shard returns 100 buckets; more accurate, more memory
}
```

### `date_histogram` — Time Series

```bash
curl -X GET "localhost:9200/orders/_search" -H 'Content-Type: application/json' -d '
{
  "size": 0,
  "query": {
    "range": { "created_at": { "gte": "now-90d", "lte": "now" } }
  },
  "aggs": {
    "orders_per_day": {
      "date_histogram": {
        "field": "created_at",
        "calendar_interval": "day",
        "format": "yyyy-MM-dd",
        "min_doc_count": 0,         ← include days with zero orders
        "extended_bounds": {
          "min": "now-90d/d",
          "max": "now/d"
        }
      }
    }
  }
}'
```

`calendar_interval` options: `minute`, `hour`, `day`, `week`, `month`, `quarter`, `year`.
`fixed_interval` options: `1h`, `30m`, `7d`, etc. (exact durations, not calendar-aware).

### `range`

```bash
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "size": 0,
  "aggs": {
    "price_ranges": {
      "range": {
        "field": "price",
        "ranges": [
          { "key": "budget",   "to": 300 },
          { "key": "mid",      "from": 300, "to": 1000 },
          { "key": "premium",  "from": 1000, "to": 2000 },
          { "key": "flagship", "from": 2000 }
        ]
      }
    }
  }
}'
```

### `filter` — Single-Bucket Aggregation

Useful for getting stats for a specific subset alongside the main results:

```bash
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "size": 10,
  "query": { "match": { "title": "laptop" } },
  "aggs": {
    "premium_laptops": {
      "filter": { "range": { "price": { "gte": 2000 } } },
      "aggs": {
        "avg_premium_price": { "avg": { "field": "price" } }
      }
    }
  }
}'
```

## Metric Aggregations

### Basic Statistics

```bash
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "size": 0,
  "aggs": {
    "price_stats": {
      "stats": { "field": "price" }
    }
  }
}'
```

`stats` returns: `count`, `min`, `max`, `avg`, `sum` in one shot. Use `extended_stats` for variance and standard deviation too.

### Percentiles

```bash
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "size": 0,
  "aggs": {
    "price_percentiles": {
      "percentiles": {
        "field": "price",
        "percents": [25, 50, 75, 95, 99]
      }
    }
  }
}'
```

**Important:** Percentiles use the **t-digest algorithm** — an approximation. The error is configurable via `compression` (default 100). Higher compression = more accurate, more memory.

### Cardinality — Counting Unique Values

```bash
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "size": 0,
  "aggs": {
    "unique_categories": {
      "cardinality": { "field": "category" }
    }
  }
}'
```

**This is an approximation** using HyperLogLog++ (HLL++). The typical error is ±5%. The error is configurable via `precision_threshold` (default 3000). Higher threshold = more accurate, more memory.

Why approximate? Counting exact unique values across distributed shards would require sending all values to the coordinating node — potentially hundreds of millions of values. HLL++ uses a fixed ~40KB sketch per field that gives you ±5% accuracy with constant memory.

For high-cardinality exact counts (like unique user IDs), accept the approximation or pre-aggregate in your pipeline.

## Nested Aggregations: Build a Dashboard

Aggs compose deeply. Here's a sales dashboard aggregation:

```bash
curl -X GET "localhost:9200/orders/_search" -H 'Content-Type: application/json' -d '
{
  "size": 0,
  "query": {
    "range": { "created_at": { "gte": "now-30d" } }
  },
  "aggs": {
    "daily_revenue": {
      "date_histogram": {
        "field": "created_at",
        "calendar_interval": "day",
        "format": "yyyy-MM-dd"
      },
      "aggs": {
        "revenue": {
          "sum": { "field": "total_amount" }
        },
        "avg_order_value": {
          "avg": { "field": "total_amount" }
        },
        "by_category": {
          "terms": {
            "field": "category",
            "size": 5
          },
          "aggs": {
            "category_revenue": {
              "sum": { "field": "total_amount" }
            }
          }
        }
      }
    },
    "top_categories_overall": {
      "terms": {
        "field": "category",
        "size": 10
      },
      "aggs": {
        "total_revenue": { "sum": { "field": "total_amount" } },
        "avg_price":     { "avg": { "field": "total_amount" } }
      }
    },
    "total_revenue": {
      "sum": { "field": "total_amount" }
    },
    "total_orders": {
      "value_count": { "field": "_id" }
    }
  }
}'
```

This returns in one request:
- Day-by-day revenue + average order value + top 5 categories per day
- Overall top 10 categories with total revenue and average price
- Total revenue and total order count for the period

## Pipeline Aggregations

Pipeline aggs operate on the output of other aggs, not raw documents.

### Cumulative Sum

```bash
"aggs": {
  "daily_orders": {
    "date_histogram": {
      "field": "created_at",
      "calendar_interval": "day"
    },
    "aggs": {
      "daily_revenue": { "sum": { "field": "total_amount" } },
      "cumulative_revenue": {
        "cumulative_sum": {
          "buckets_path": "daily_revenue"
        }
      }
    }
  }
}
```

### Moving Average

```bash
"moving_avg_revenue": {
  "moving_avg": {
    "buckets_path": "daily_revenue",
    "window": 7       ← 7-day rolling average
  }
}
```

### Bucket Sort (Sort Buckets by Metric)

```bash
"aggs": {
  "by_category": {
    "terms": { "field": "category", "size": 50 },
    "aggs": {
      "revenue": { "sum": { "field": "total_amount" } },
      "revenue_sort": {
        "bucket_sort": {
          "sort": [{ "revenue": { "order": "desc" } }],
          "size": 10     ← return only top 10 categories by revenue
        }
      }
    }
  }
}
```

## Performance Considerations

**Memory:** Each bucket in a `terms` agg allocates memory per shard. For `"size": 1000` with 10 shards and `shard_size: 5000`, you're holding 50,000 buckets in memory per node during the aggregation.

**Cardinality amplifies with nesting:** A `terms` agg with 100 buckets, each with a sub-`terms` agg with 50 buckets = 5,000 buckets. Add one more level and you're at 250,000.

**`eager_global_ordinals`:** For `keyword` fields with frequent `terms` aggs, enable eager global ordinals to avoid rebuilding the ordinal mapping on first query after a refresh:

```json
"category": {
  "type": "keyword",
  "eager_global_ordinals": true
}
```

**Sampling:** For exploratory analytics on large indexes, use `sampler` agg to work on a subset:

```bash
"aggs": {
  "sample": {
    "sampler": { "shard_size": 1000 },    ← analyze 1000 docs per shard
    "aggs": {
      "significant_terms": {
        "significant_terms": { "field": "tags" }
      }
    }
  }
}
```

## Key Takeaways

- **Aggregations use `doc_values`**, not the inverted index. This is why `text` fields can't be aggregated — they have no `doc_values`.
- **`terms` agg counts are approximate** for multi-shard indexes. Increase `shard_size` for better accuracy at the cost of memory.
- **`cardinality` agg uses HyperLogLog++** — fixed memory, ~5% error. Exact unique counts aren't practical at scale.
- **`percentiles` uses t-digest** — another approximation. Use `compression` parameter to tune accuracy vs memory.
- **Nested aggs multiply memory usage.** Three levels deep with 100 buckets each = 1 million bucket combinations.
- **`date_histogram` + `min_doc_count: 0` + `extended_bounds`** gives you complete time series with zero-filled gaps.

## Next Steps

You can search, rank, filter, and aggregate. The remaining question is: how does Elasticsearch keep your data safe when nodes fail? That's cluster architecture and replication.

---

**Part 6 complete. Next: [Cluster Architecture & Replication](/blog/es-series-7-cluster-replication/)**
