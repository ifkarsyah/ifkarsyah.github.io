---
title: "Elasticsearch Internals Series, Part 5: Query DSL Deep Dive"
description: "Query vs filter context, bool query anatomy, leaf queries, pagination strategies, and building a real product search from scratch."
pubDate: 2026-03-30
author: "ifkarsyah"
domain: "Search"
stack: ["Elasticsearch"]
image:
  src: ./es-series.png
  alt: "Elasticsearch Query DSL"
---

The Query DSL is Elasticsearch's language for expressing search intent. But it has a split personality: some clauses compute relevance scores (query context), others just filter documents (filter context). Using them wrong costs you cache hits and CPU.

This part covers the entire Query DSL systematically, then builds a realistic product search query that you can adapt for your own use case.

## Query Context vs Filter Context

**Query context:** "How well does this document match?" Scores are calculated. Results are ranked.

**Filter context:** "Does this document match or not?" Binary yes/no. No scores. Results are cached by Elasticsearch's filter cache.

```
                     Query Context         Filter Context
                     ─────────────────     ─────────────────
Computes score?      Yes                   No
Cached?              No                    Yes (bitset cache)
Use for:             Relevance ranking     Exact match, ranges,
                     full-text search      boolean conditions
Example:             match, multi_match    term, range, exists,
                     match_phrase          terms, ids
```

The filter cache stores bitsets (one bit per document). On subsequent requests for the same filter, Elasticsearch skips evaluation entirely — it just applies the cached bitset to the result set.

**Rule of thumb:** If a condition doesn't affect _how relevant_ a document is, put it in a filter. `category = "laptops"` doesn't make a laptop more or less relevant to a query about "gaming" — it's a hard constraint. Filters for exact matches, ranges, and boolean conditions.

## The `bool` Query

`bool` is the workhorse query. It composes multiple clauses:

```json
{
  "query": {
    "bool": {
      "must":     [...],    ← query context: must match AND contributes to score
      "should":   [...],    ← query context: boosts score if matches (or required if no must/filter)
      "filter":   [...],    ← filter context: must match, not scored, cached
      "must_not": [...]     ← filter context: must NOT match, not scored, cached
    }
  }
}
```

**`must`**: Document must match. Contributes to score. Think "AND" for relevance.

**`should`**: Document doesn't have to match, but matching improves the score. Think "OR" for relevance. With `minimum_should_match: 1`, at least one should clause must match.

**`filter`**: Document must match. Does NOT contribute to score. Cached. Think "AND" for filtering.

**`must_not`**: Document must NOT match. Does not contribute to score. Cached. Think "NOT".

**Example — product search with all four:**

```bash
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "query": {
    "bool": {
      "must": [
        {
          "multi_match": {
            "query": "gaming laptop",
            "fields": ["title^3", "description"]
          }
        }
      ],
      "should": [
        { "term": { "tags": "nvidia" } },
        { "range": { "rating": { "gte": 4.5 } } }
      ],
      "filter": [
        { "term": { "category": "laptops" } },
        { "range": { "price": { "gte": 500, "lte": 2000 } } },
        { "term": { "in_stock": true } }
      ],
      "must_not": [
        { "term": { "status": "discontinued" } }
      ]
    }
  }
}'
```

What this does:
- **must**: documents must contain "gaming laptop" in title or description (scored)
- **should**: bonus score if tagged "nvidia" or highly rated (not required, just boosts)
- **filter**: only laptops, priced $500–$2000, in stock (no score impact, cached)
- **must_not**: exclude discontinued products (no score impact, cached)

## Leaf Query Reference

### `match` — Full-Text Search on a Single Field

```json
{
  "query": {
    "match": {
      "title": {
        "query": "gaming laptop",
        "operator": "and",         ← both "gaming" AND "laptop" must match (default: "or")
        "minimum_should_match": "75%",
        "fuzziness": "AUTO"        ← tolerate 1-2 character typos
      }
    }
  }
}
```

`fuzziness: "AUTO"` applies Levenshtein edit distance: 0 edits for 1-2 char terms, 1 edit for 3-5 chars, 2 edits for 6+ chars. "lptop" matches "laptop".

### `match_phrase` — Exact Phrase

```json
{
  "query": {
    "match_phrase": {
      "title": {
        "query": "gaming laptop",
        "slop": 1     ← allow 1 word between "gaming" and "laptop"
      }
    }
  }
}
```

With `slop: 0` (default), "gaming laptop" only matches if "gaming" is immediately followed by "laptop". With `slop: 1`, "gaming pro laptop" also matches.

### `term` — Exact Keyword Match

```json
{ "query": { "term": { "category": "laptops" } } }
```

No analysis. `"Laptops"` (capital L) would NOT match `"laptops"` in the index. Always use lowercase for keyword fields.

### `terms` — Match Any of a List

```json
{ "query": { "terms": { "category": ["laptops", "tablets", "phones"] } } }
```

### `range`

```json
{
  "query": {
    "range": {
      "price": { "gte": 500, "lte": 2000 },
      "created_at": { "gte": "now-30d/d", "lte": "now/d" }
    }
  }
}
```

Date math: `now-30d/d` = 30 days ago, rounded to the day (the `/d` makes it cacheable — without rounding, `now` changes every millisecond and the filter can never be cached).

### `exists`

```json
{ "query": { "exists": { "field": "discount_price" } } }
```

Matches documents where the field exists and is not null.

### `ids`

```json
{ "query": { "ids": { "values": ["1", "2", "3"] } } }
```

Efficient for fetching a known set of documents by ID.

### `prefix` and `wildcard`

```json
{ "query": { "prefix": { "title.keyword": "gam" } } }
{ "query": { "wildcard": { "title.keyword": "gam*ng" } } }
```

**Avoid leading wildcards (`*laptop`).** They require scanning every term in the index. If you need prefix search on analyzed text, use the `search_as_you_type` field type instead.

### `fuzzy`

```json
{
  "query": {
    "fuzzy": {
      "title": {
        "value": "lptop",
        "fuzziness": 1,
        "prefix_length": 2   ← first 2 chars must match exactly (improves performance)
      }
    }
  }
}
```

## Pagination

### `from` / `size` (Classic Pagination)

```bash
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "from": 0,
  "size": 20,
  "query": { "match": { "title": "laptop" } }
}'
```

**The deep pagination problem:** For `from: 9980, size: 20`, each shard returns its top 10,000 results. The coordinating node receives 30,000 candidates (across 3 shards), sorts them all, discards 9,980, and returns 20. Memory and CPU scale linearly with depth.

**Elasticsearch's hard limit:** `from + size` cannot exceed `index.max_result_window` (default 10,000). You can raise it, but you shouldn't.

### `search_after` (Keyset Pagination)

For deep pagination, use `search_after`. It uses the sort values of the last result as the starting point for the next page — no expensive offset calculation.

```bash
# First page
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "size": 20,
  "query": { "match": { "title": "laptop" } },
  "sort": [
    { "_score": "desc" },
    { "_id": "asc" }         ← tie-breaker: must be a unique, stable field
  ]
}'

# Response includes sort values for the last hit:
# "sort": [0.93, "p042"]

# Next page — use those sort values as the cursor
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "size": 20,
  "query": { "match": { "title": "laptop" } },
  "sort": [
    { "_score": "desc" },
    { "_id": "asc" }
  ],
  "search_after": [0.93, "p042"]
}'
```

`search_after` is O(1) in depth. But it requires a **stable sort** (always include `_id` or another unique field as a tiebreaker), and you can't jump to an arbitrary page — only forward.

### Point-in-Time (PIT) + `search_after`

`search_after` has a problem: between pages, new documents might be indexed or existing ones deleted, shifting the ranking. The cursor can miss or duplicate documents.

**Point-in-Time** (PIT) creates a frozen snapshot of the index for consistent pagination:

```bash
# Open a PIT (snapshot of current state)
curl -X POST "localhost:9200/products/_pit?keep_alive=5m"
# Response: { "id": "46ToAwMDaWQy..." }

# Paginate using the PIT ID
curl -X GET "localhost:9200/_search" -H 'Content-Type: application/json' -d '
{
  "size": 20,
  "query": { "match": { "title": "laptop" } },
  "sort": [{ "_score": "desc" }, { "_id": "asc" }],
  "pit": {
    "id": "46ToAwMDaWQy...",
    "keep_alive": "5m"
  }
}'

# Close the PIT when done
curl -X DELETE "localhost:9200/_pit" -H 'Content-Type: application/json' -d '
{ "id": "46ToAwMDaWQy..." }'
```

Each paginated request extends the PIT `keep_alive` timer. Close PITs explicitly when done — they consume heap on the data nodes.

## Highlighting

Return matching snippets with highlighted terms:

```bash
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "query": { "match": { "description": "gaming performance" } },
  "highlight": {
    "fields": {
      "description": {
        "pre_tags": ["<strong>"],
        "post_tags": ["</strong>"],
        "fragment_size": 150,
        "number_of_fragments": 3
      }
    }
  }
}'
```

Response includes a `highlight` object per hit:
```json
"highlight": {
  "description": [
    "Ultimate <strong>gaming</strong> <strong>performance</strong> in a thin chassis."
  ]
}
```

## Building a Real Product Search

Let's put it all together: a product search with full-text, filters, boosting, and pagination.

```bash
curl -X GET "localhost:9200/products/_search" -H 'Content-Type: application/json' -d '
{
  "size": 20,
  "sort": [
    { "_score": "desc" },
    { "created_at": "desc" },
    { "_id": "asc" }
  ],
  "query": {
    "bool": {
      "must": [
        {
          "multi_match": {
            "query": "gaming laptop",
            "fields": ["title^4", "description^1", "tags^2"],
            "type": "best_fields",
            "fuzziness": "AUTO",
            "minimum_should_match": "60%"
          }
        }
      ],
      "should": [
        { "term":  { "tags": "nvidia" } },
        { "range": { "rating": { "gte": 4.5, "boost": 1.5 } } }
      ],
      "filter": [
        { "term":  { "in_stock": true } },
        { "range": { "price": { "gte": 500, "lte": 3000 } } }
      ],
      "must_not": [
        { "term": { "status": "discontinued" } }
      ]
    }
  },
  "highlight": {
    "fields": {
      "title":       { "number_of_fragments": 0 },
      "description": { "fragment_size": 200, "number_of_fragments": 2 }
    }
  },
  "aggs": {
    "categories": {
      "terms": { "field": "category", "size": 10 }
    },
    "price_ranges": {
      "range": {
        "field": "price",
        "ranges": [
          { "to": 500 },
          { "from": 500, "to": 1000 },
          { "from": 1000, "to": 2000 },
          { "from": 2000 }
        ]
      }
    }
  }
}'
```

This query:
1. Searches `title` (4x boost), `tags` (2x boost), `description` with fuzzy matching
2. Boosts highly-rated products and nvidia-tagged ones
3. Filters to in-stock, $500–$3000 products
4. Excludes discontinued items
5. Returns highlighted snippets for context
6. Includes facet aggregations for UI filters

## Key Takeaways

- **Filter context vs query context** is the most important distinction. Filters are cached as bitsets. Queries are scored. Use filters for all hard constraints.
- **`bool`** is the primary composition primitive: `must` (scored AND), `should` (scored OR), `filter` (cached AND), `must_not` (cached NOT).
- **`from/size` doesn't scale** beyond a few thousand results. Use `search_after` + PIT for deep pagination.
- **Date math with rounding** (`now-30d/d`) makes range filters cacheable. Without rounding, `now` changes every millisecond.
- **`match`** analyzes the query string. **`term`** does not. Never use `term` on a `text` field.
- **Boost at the field level** (`title^3`) changes how IDF and TF interact for that field's score contribution.

## Next Steps

You can now search and rank documents. The next dimension of Elasticsearch is analytics: counting, grouping, computing statistics across your data. Aggregations work completely differently from search — they use `doc_values`, not the inverted index.

---

**Part 5 complete. Next: [Aggregations & Analytics](/blog/es-series-6-aggregations/)**
