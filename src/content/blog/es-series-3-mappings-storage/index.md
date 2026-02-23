---
title: "Elasticsearch Internals Series, Part 3: Document Storage & Mappings"
description: "How Elasticsearch stores fields in multiple representations — _source, inverted index, doc_values, fielddata — and why the wrong mapping kills performance."
pubDate: 2026-03-16
author: "ifkarsyah"
domain: "Search"
stack: ["Elasticsearch"]
image:
  src: ./es-series.png
  alt: "Elasticsearch Document Storage and Mappings"
---

When you index a document, Elasticsearch doesn't store it once — it stores multiple representations of each field, each optimized for a different operation. The inverted index is for search. `doc_values` is for aggregations and sorting. `_source` is for retrieving the original document. These representations live side-by-side in each segment.

Understanding this architecture tells you exactly what to enable and disable to optimize for your workload.

## The Four Storage Representations

For each field, Elasticsearch can maintain up to four separate data structures:

```
Document: { "title": "Gaming Laptop", "price": 1299, "category": "electronics" }

                    What gets stored per field:
┌─────────────────────────────────────────────────────────────────────┐
│ _source (stored fields)                                              │
│   Raw JSON blob. Retrieved when you fetch a document.               │
│   { "title": "Gaming Laptop", "price": 1299, ... }                  │
├─────────────────────────────────────────────────────────────────────┤
│ Inverted index (per text/keyword field)                              │
│   "gaming"   → [doc1, doc5, doc12]                                  │
│   "laptop"   → [doc1, doc3, doc7]                                   │
│   Used for: search queries (match, term, bool)                      │
├─────────────────────────────────────────────────────────────────────┤
│ doc_values (column-store, per non-text field)                        │
│   doc1 → 1299                                                        │
│   doc2 → 59                                                          │
│   Used for: sorting, aggregations, scripting                        │
├─────────────────────────────────────────────────────────────────────┤
│ fielddata (in-heap, text fields only, disabled by default)           │
│   Inverted index inverted again at query time into per-doc values   │
│   Loaded into JVM heap on first use. Expensive.                     │
│   Used for: aggregations on analyzed text (rare, usually wrong)     │
└─────────────────────────────────────────────────────────────────────┘
```

## `_source`

`_source` is the original JSON document you sent to Elasticsearch, stored verbatim in a compressed column. It's not indexed — it's just stored so Elasticsearch can return your original document in search results.

By default, `_source` is enabled. You can disable it:

```json
"mappings": {
  "_source": { "enabled": false }
}
```

**When to disable `_source`:**
- You're building a pure analytics index where you never need to retrieve individual documents (only aggregations)
- Disk space is critical and you can reconstruct data from elsewhere

**Consequences of disabling `_source`:**
- `GET /index/_doc/1` returns no `_source`
- `_update` API stops working (it needs to read the current document to apply partial updates)
- Reindexing becomes impossible (source is gone)

Most production indexes keep `_source` enabled.

### Source Filtering

You can exclude large fields from `_source` while keeping them indexed:

```json
"mappings": {
  "_source": {
    "excludes": ["raw_html", "large_blob_field"]
  }
}
```

Or retrieve only specific fields at query time:

```bash
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "_source": ["title", "price"],
  "query": { "match_all": {} }
}'
```

## `doc_values`

`doc_values` is a **column-oriented store** written to disk at index time. For each field, it stores a mapping from document ID to field value — the opposite of the inverted index.

```
doc_values for "price":
  doc_id 0 → 1299
  doc_id 1 → 59
  doc_id 2 → 149
  doc_id 3 → 799
```

This columnar layout is exactly what sorting and aggregations need: to compute the average price, read all values in the `price` column sequentially. Much faster than reading entire documents one by one from `_source`.

`doc_values` is enabled by default for all field types **except `text`** (analyzed text). You can disable it for fields you never sort or aggregate on:

```json
"mappings": {
  "properties": {
    "description": {
      "type": "text",
      "doc_values": false     ← text fields don't support doc_values anyway
    },
    "internal_id": {
      "type": "keyword",
      "doc_values": false,    ← if you never aggregate or sort by this
      "index": true
    }
  }
}
```

**When to disable `doc_values`:**
- The field is only used for search (never sort, aggregate, or script)
- Saving disk space matters (doc_values can be 30-50% of index size)

## `fielddata`

`fielddata` is the dangerous one. It's an **in-heap** data structure built from the inverted index at query time, enabling aggregations on `text` fields.

```bash
# This will FAIL by default
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "aggs": {
    "top_words": {
      "terms": { "field": "title" }     ← title is a text field
    }
  }
}'
# → "Fielddata is disabled on text fields by default"
```

To enable it:

```json
"mappings": {
  "properties": {
    "title": {
      "type": "text",
      "fielddata": true
    }
  }
}
```

**Why `fielddata` is disabled by default:**
- Built at query time by inverting the inverted index — CPU intensive on first load
- Lives entirely in JVM heap (not off-heap like `doc_values`)
- For a large index, loading fielddata for a text field can consume gigabytes of heap
- Results in "Data too large" errors and OOM kills in production

**The right solution:** If you need to aggregate on text values, use a `keyword` sub-field (Part 1's multi-field pattern):

```json
"title": {
  "type": "text",
  "fields": {
    "keyword": { "type": "keyword" }
  }
}
```

Then aggregate on `title.keyword` (uses `doc_values`) instead of `title` (would need `fielddata`).

## Field Types Reference

Understanding storage starts with choosing the right field type:

### Text vs Keyword

| | `text` | `keyword` |
|---|---|---|
| Analysis | Yes (tokenized, lowercased, etc.) | No (stored verbatim) |
| Inverted index | Yes | Yes |
| doc_values | No | Yes |
| Use for | Full-text search | Exact match, aggregations, sorting |
| Example | Product description | Product ID, status, tag |

```json
"status": { "type": "keyword" }        ← "active", "inactive", "pending"
"description": { "type": "text" }      ← "A fast laptop with..."
```

### Numeric Types

| Type | Size | Use |
|---|---|---|
| `long` | 8 bytes | IDs, timestamps (epoch ms) |
| `integer` | 4 bytes | Counts, ages |
| `short` | 2 bytes | Small range values |
| `byte` | 1 byte | Very small values |
| `double` | 8 bytes | High-precision decimals |
| `float` | 4 bytes | Approximate decimals |
| `scaled_float` | 8 bytes | Decimals with fixed scale (e.g., prices: 1299 = 12.99 × 100) |

For prices, prefer `scaled_float` with a scaling factor (avoids floating point precision issues):

```json
"price": {
  "type": "scaled_float",
  "scaling_factor": 100    ← 12.99 stored as integer 1299
}
```

### Date

Dates are stored as milliseconds since epoch internally. You control the display format:

```json
"created_at": {
  "type": "date",
  "format": "yyyy-MM-dd HH:mm:ss||yyyy-MM-dd||epoch_millis"
}
```

### Object vs Nested

This distinction trips up many engineers.

**`object`** (default for JSON objects):

```json
{
  "title": "Laptop",
  "specs": {
    "ram": "16GB",
    "storage": "512GB"
  }
}
```

Internally, Elasticsearch flattens object fields:

```
title         → "Laptop"
specs.ram     → "16GB"
specs.storage → "512GB"
```

**The array-of-objects problem:**

```json
{
  "title": "Laptop",
  "reviews": [
    { "user": "alice", "rating": 5 },
    { "user": "bob",   "rating": 1 }
  ]
}
```

With `object` type, this is flattened to:

```
reviews.user   → ["alice", "bob"]
reviews.rating → [5, 1]
```

The association between `alice` and `5` is lost. A query for "user alice with rating 1" would match this document — wrong.

**`nested`** type preserves the relationship:

```json
"reviews": {
  "type": "nested"
}
```

Each nested object is stored as a hidden separate document, maintaining field associations. Nested queries work correctly:

```bash
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "query": {
    "nested": {
      "path": "reviews",
      "query": {
        "bool": {
          "must": [
            { "term": { "reviews.user": "alice" } },
            { "term": { "reviews.rating": 5 } }
          ]
        }
      }
    }
  }
}'
```

**The cost:** Each nested document is a hidden Lucene document. A product with 100 reviews means 101 Lucene documents. For high-volume nested arrays, this explodes the document count.

## Explicit vs Dynamic Mapping

By default, Elasticsearch **dynamically maps** new fields: when it sees a new field for the first time, it guesses the type and adds it to the mapping.

```bash
# No mapping defined — ES will infer
curl -X POST "localhost:9200/logs/_doc" -H 'Content-Type: application/json' -d '
{
  "timestamp": "2026-03-01T12:00:00",
  "level": "ERROR",
  "message": "Connection refused",
  "response_time_ms": 523
}'

# Check what ES inferred
curl -X GET "localhost:9200/logs/_mapping?pretty"
```

ES inferred:
- `timestamp` → `date`
- `level` → `text` + `keyword` sub-field
- `message` → `text` + `keyword` sub-field
- `response_time_ms` → `long`

**Dynamic mapping problems:**

1. `"error_code": "404"` — ES sees a string containing a number and maps it as `text` + `keyword`. Later you want to do range queries on it. Too late.
2. `"user_data": { ... }` — an unexpected deeply nested object causes mapping explosion (thousands of fields).

**Disable dynamic mapping for production:**

```json
"mappings": {
  "dynamic": "strict",   ← reject documents with unmapped fields
  "properties": {
    "title": { "type": "text" },
    "price": { "type": "scaled_float", "scaling_factor": 100 }
  }
}
```

With `"dynamic": "strict"`, indexing a document with an unknown field returns an error. This prevents surprise schema changes.

## Hands-On: Mapping Decisions in Practice

Let's build a product catalog index with intentional mapping decisions:

```bash
curl -X PUT "localhost:9200/products_v1" -H 'Content-Type: application/json' -d '
{
  "settings": {
    "number_of_shards": 2,
    "number_of_replicas": 0
  },
  "mappings": {
    "dynamic": "strict",
    "_source": { "enabled": true },
    "properties": {
      "id": {
        "type": "keyword",
        "doc_values": false      ← never aggregate on IDs
      },
      "title": {
        "type": "text",
        "analyzer": "english",
        "fields": {
          "keyword": {
            "type": "keyword",
            "ignore_above": 256  ← skip indexing titles > 256 chars for exact match
          }
        }
      },
      "description": {
        "type": "text",
        "analyzer": "english",
        "index_options": "positions"
      },
      "price": {
        "type": "scaled_float",
        "scaling_factor": 100
      },
      "category": {
        "type": "keyword"
      },
      "tags": {
        "type": "keyword"         ← array of keywords, handled natively
      },
      "created_at": {
        "type": "date",
        "format": "yyyy-MM-dd HH:mm:ss"
      },
      "reviews": {
        "type": "nested",
        "properties": {
          "user_id": { "type": "keyword", "doc_values": false },
          "rating":  { "type": "byte" },
          "comment": { "type": "text", "index": false }  ← stored but not searched
        }
      }
    }
  }
}'
```

Index some documents:

```bash
curl -X POST "localhost:9200/products_v1/_bulk" -H 'Content-Type: application/json' -d '
{ "index": { "_id": "1" } }
{ "id": "p001", "title": "Gaming Laptop 16-inch", "description": "High performance gaming laptop with RTX 4080", "price": 1999.99, "category": "laptops", "tags": ["gaming", "laptop", "nvidia"], "created_at": "2026-01-15 10:00:00", "reviews": [{"user_id": "u1", "rating": 5, "comment": "Excellent!"}, {"user_id": "u2", "rating": 4, "comment": "Great value"}] }
{ "index": { "_id": "2" } }
{ "id": "p002", "title": "Wireless Mouse", "description": "Ergonomic wireless mouse with long battery life", "price": 49.99, "category": "peripherals", "tags": ["wireless", "mouse", "ergonomic"], "created_at": "2026-01-20 14:30:00", "reviews": [{"user_id": "u3", "rating": 3, "comment": "Average quality"}] }
'
```

Check the actual mapping that was applied:

```bash
curl -X GET "localhost:9200/products_v1/_mapping?pretty"
```

## Checking Storage Usage Per Field

```bash
curl -X GET "localhost:9200/products_v1/_stats/store?pretty"
```

For a more detailed breakdown by field:

```bash
curl -X POST "localhost:9200/products_v1/_field_stats" -H 'Content-Type: application/json' -d '
{
  "fields": ["title", "price", "category"]
}'
```

## Key Takeaways

- **Every field is stored in up to four representations**: `_source` (raw JSON), inverted index (search), `doc_values` (aggregations/sorting), `fielddata` (text aggregations — dangerous, avoid).
- **`doc_values` is on-disk, off-heap.** It's the correct way to aggregate non-text fields. It's enabled by default for all non-`text` fields.
- **`fielddata` is in-heap and built at query time.** It can OOM your cluster. Use a `keyword` sub-field instead.
- **`text` vs `keyword` is fundamental.** Text for full-text search. Keyword for exact match, aggregations, sorting.
- **`object` arrays lose field associations.** Use `nested` type for arrays of objects when you need correlated field queries.
- **`dynamic: strict`** prevents surprise schema changes in production.

## Next Steps

Now you understand how data is stored. The next question is: when you run a search query, how does Elasticsearch find relevant documents and rank them? That's the scatter-gather execution model and BM25 scoring.

---

**Part 3 complete. Next: [Search Internals & Relevance Scoring](/blog/es-series-4-search-scoring/)**
