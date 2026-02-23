---
title: "Elasticsearch Internals Series, Part 4: Search Internals & Relevance Scoring"
description: "How a search query flows from client to shards and back, how BM25 calculates relevance scores, and how to debug scoring with the _explain API."
pubDate: 2026-03-23
author: "ifkarsyah"
domain: "Search"
stack: ["Elasticsearch"]
image:
  src: ./es-series.png
  alt: "Elasticsearch Search Internals and Scoring"
---

You type a query. Elasticsearch returns results ranked by relevance. But what does "relevance" actually mean? How does Elasticsearch decide that Document A is more relevant than Document B?

The answer is BM25 — a probabilistic scoring model used by Elasticsearch since version 5.0. Understanding it turns relevance from magic into math you can reason about and tune.

## The Query Execution Flow

Every search query follows the same scatter-gather pattern:

```
Client
  │
  │  GET /products/_search { "query": {...} }
  ▼
Coordinating Node  (any node — could be the same as a data node)
  │
  │ Phase 1: QUERY phase (scatter)
  ├──────────────────────────────────┐
  │                                  │
  ▼                                  ▼
Shard 0  (primary or replica)    Shard 1  (primary or replica)
  │                                  │
  │ Local search:                    │ Local search:
  │   - Top-N doc IDs                │   - Top-N doc IDs
  │   - Scores                       │   - Scores
  └──────────────┬───────────────────┘
                 │
                 ▼
         Coordinating Node
           │
           │ Phase 2: FETCH phase (gather)
           │   - Merge top-N from all shards
           │   - Rank globally
           │   - Fetch full documents (_source) for top results
           │
           ▼
         Client  (final ranked results)
```

### Query Phase (Scatter)

Each shard independently:
1. Runs the query against its local Lucene index
2. Produces a list of `(doc_id, score)` pairs
3. Returns only the **top N** results (not all matching documents)

For `from: 0, size: 10`, each shard returns its top 10. If you have 3 shards, the coordinating node receives up to 30 results.

### Fetch Phase (Gather)

The coordinating node:
1. Merges results from all shards (30 candidates)
2. Sorts globally by score
3. Determines which 10 to return
4. Fetches the full `_source` for those 10 documents (another round trip to the relevant shards)

**This is why deep pagination is expensive.** For `from: 9990, size: 10`, each shard must return its top 10,000 results. The coordinating node receives 30,000 candidates, merges them, and returns the 10 at position 9990–10000.

## BM25: How Scores Are Calculated

Elasticsearch uses **BM25** (Best Match 25) as its default similarity algorithm. It's a ranking function that estimates how relevant a document is to a query based on term statistics.

BM25 score for a query term `q` in document `d`:

```
score(q, d) = IDF(q) × TF_normalized(q, d)

where:

IDF(q) = log(1 + (N - df + 0.5) / (df + 0.5))
  N  = total number of documents in the shard
  df = number of documents containing term q

TF_normalized(q, d) = tf × (k1 + 1) / (tf + k1 × (1 - b + b × (|d| / avgdl)))
  tf    = term frequency in document d
  |d|   = length of document d (in tokens)
  avgdl = average document length across the index
  k1    = saturation parameter (default 1.2): controls TF saturation
  b     = length normalization (default 0.75): controls length penalty
```

In plain terms:

- **IDF (Inverse Document Frequency)**: Rare terms score higher. "the" appears in every document (low IDF). "elasticsearch" appears in few documents (high IDF).
- **TF (Term Frequency)**: Documents where the term appears more often score higher — but with diminishing returns (the `k1` parameter saturates TF growth).
- **Length normalization**: Long documents are penalized slightly. A short document with "laptop" once is considered a better match than a book that mentions "laptop" once — the term is more "central" to the short document.

## The Shard-Scoring Problem

Here's the subtle issue: **IDF is computed per-shard, not globally**.

Each shard computes `N` (total docs) and `df` (doc frequency) based on its local data. If your data is unevenly distributed, the same term has different IDF on different shards — and the same query returns slightly different scores depending on which shard a document lives on.

**Example:**

- Shard 0 has 1,000 docs, 10 containing "laptop" → IDF = log(1 + 991/10.5) ≈ 4.6
- Shard 1 has 1,000 docs, 200 containing "laptop" → IDF = log(1 + 801/200.5) ≈ 1.4

A document on Shard 0 scores much higher than an identical document on Shard 1.

**Solutions:**

1. **`dfs_query_then_fetch`**: Pre-fetches global term statistics before scoring. More accurate, slower (extra round trip).

```bash
curl -X GET "localhost:9200/products/_search?search_type=dfs_query_then_fetch" -H 'Content-Type: application/json' -d '
{ "query": { "match": { "title": "laptop" } } }'
```

2. **Use enough documents**: With millions of documents, statistical variation between shards averages out. For small or skewed indexes, `dfs_query_then_fetch` is the right call.

3. **Use 1 shard** for small indexes: Single shard = global statistics = no skew. Reasonable for indexes under ~10GB.

## Hands-On: The `_explain` API

The `_explain` API shows you exactly how a score was calculated for a specific document.

```bash
# First, index some products
curl -X POST "localhost:9200/products/_bulk" -H 'Content-Type: application/json' -d '
{ "index": { "_id": "1" } }
{ "title": "Gaming Laptop 16-inch with RTX 4080", "description": "Ultimate gaming performance" }
{ "index": { "_id": "2" } }
{ "title": "Business Laptop 14-inch", "description": "Thin and light laptop for productivity" }
{ "index": { "_id": "3" } }
{ "title": "Laptop Stand", "description": "Adjustable stand for any laptop" }
'

curl -X POST "localhost:9200/products/_refresh"

# Get score explanation for doc 1
curl -X GET "localhost:9200/products/_explain/1" -H 'Content-Type: application/json' -d '
{ "query": { "match": { "title": "laptop" } } }'
```

Response (abbreviated):
```json
{
  "_id": "1",
  "matched": true,
  "explanation": {
    "value": 0.13353139,
    "description": "weight(title:laptop in 0) [PerFieldSimilarity], result of:",
    "details": [
      {
        "value": 0.13353139,
        "description": "score(freq=1.0), computed as boost * idf * tf from:",
        "details": [
          {
            "value": 2.2,
            "description": "boost"
          },
          {
            "value": 0.13353139,
            "description": "idf, computed as log(1 + (N - n + 0.5) / (n + 0.5)) from:",
            "details": [
              { "value": 3, "description": "n, number of documents containing term" },
              { "value": 3, "description": "N, total number of documents with field" }
            ]
          },
          {
            "value": 0.45454544,
            "description": "tf, computed as freq / (freq + k1 * (1 - b + b * dl / avgdl)) from:",
            "details": [
              { "value": 1.0,  "description": "freq, occurrences of term within document" },
              { "value": 1.2,  "description": "k1, term saturation parameter" },
              { "value": 0.75, "description": "b, length normalization parameter" },
              { "value": 7.0,  "description": "dl, length of field (approximate number of terms)" },
              { "value": 6.0,  "description": "avgdl, average length of field" }
            ]
          }
        ]
      }
    ]
  }
}
```

All three documents contain "laptop", so IDF is low (n=3, N=3). Document 1 scores highest because its `title` field is shorter (more dense match) — or Document 3 might score highest since "Laptop Stand" has fewer total tokens.

Use `_explain` whenever search results feel wrong. It will tell you exactly why a document scored what it scored.

## Boosting

You can adjust scores at query time without changing the underlying data.

### Field Boost

```bash
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "query": {
    "multi_match": {
      "query": "laptop",
      "fields": ["title^3", "description^1"]   ← title matches count 3x more
    }
  }
}'
```

### Query Boost

```bash
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "query": {
    "bool": {
      "should": [
        { "match": { "title": { "query": "laptop", "boost": 3.0 } } },
        { "match": { "description": { "query": "laptop", "boost": 1.0 } } }
      ]
    }
  }
}'
```

### `function_score` — Custom Scoring

For complex scoring needs (boost recent documents, boost popular items, combine text score with a numeric value):

```bash
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "query": {
    "function_score": {
      "query": {
        "match": { "title": "laptop" }
      },
      "functions": [
        {
          "field_value_factor": {
            "field": "popularity_score",
            "factor": 1.2,
            "modifier": "sqrt",
            "missing": 1
          }
        },
        {
          "gauss": {
            "created_at": {
              "origin": "now",
              "scale": "30d",
              "decay": 0.5
            }
          }
        }
      ],
      "score_mode": "multiply",
      "boost_mode": "multiply"
    }
  }
}'
```

This multiplies the BM25 text score by:
- `sqrt(popularity_score) * 1.2` — boost popular items
- Gaussian decay on `created_at` — items from 30 days ago get 0.5x score

## Inspecting Scores in Search Results

Add `explain: true` to a search request to get score details for all returned documents:

```bash
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "explain": true,
  "query": { "match": { "title": "laptop" } }
}'
```

This is verbose but invaluable for debugging. The `_score` field in each hit is the final score after all boosts and functions.

## Similarity Models

BM25 is the default but not the only option. You can configure similarity per field:

```json
"settings": {
  "similarity": {
    "my_bm25": {
      "type": "BM25",
      "k1": 2.0,
      "b": 0.5
    }
  }
},
"mappings": {
  "properties": {
    "title": {
      "type": "text",
      "similarity": "my_bm25"
    }
  }
}
```

**Tuning `k1`:** Higher values allow term frequency to have more impact (no saturation plateau). Useful for long-form content.

**Tuning `b`:** `b=0` disables length normalization (useful when document length isn't meaningful — e.g., all documents are product titles of similar length). `b=1` fully normalizes for length.

## Key Takeaways

- **Search is scatter-gather**: each shard independently scores and returns top-N, the coordinating node merges globally.
- **BM25** rewards rare terms (IDF), higher frequency (TF, saturating), and shorter documents (length normalization).
- **IDF is computed per-shard** by default. With skewed data distributions, use `dfs_query_then_fetch` or `search_type=dfs_query_then_fetch` for accurate scores.
- **`_explain` API** gives you the full scoring breakdown for any document — use it to debug relevance issues.
- **Boost** at the field level (`^3`) or query level to tune relevance without changing data.
- **`function_score`** for complex custom ranking combining text relevance with numeric factors.

## Next Steps

You now understand how search works internally. The next step is using this knowledge to write efficient queries. The Query DSL has two modes — query context (scoring) and filter context (caching) — and knowing the difference fundamentally changes query performance.

---

**Part 4 complete. Next: [Query DSL Deep Dive](/blog/es-series-5-query-dsl/)**
