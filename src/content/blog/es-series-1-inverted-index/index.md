---
title: "Elasticsearch Internals Series, Part 1: Inverted Index & Text Analysis"
description: "How Elasticsearch stores text for full-text search — inverted index structure, analyzers, tokenizers, token filters, and practical inspection with _analyze and _termvectors."
pubDate: 2026-03-02
author: "ifkarsyah"
domain: "Search"
stack: ["Elasticsearch"]
image:
  src: ./es-series.png
  alt: "Elasticsearch Inverted Index"
---

The inverted index is the reason Elasticsearch is fast at full-text search. It's not a general-purpose data structure — it's purpose-built for one thing: given a word, find all documents that contain it, instantly.

But before any text lands in the inverted index, it goes through **analysis** — a pipeline that transforms raw text into a set of tokens. The analysis pipeline determines what you can search for and how. Get it wrong and your search is broken from the start.

## What Is an Inverted Index?

A traditional relational database stores data row-by-row. If you want to find all rows where a column contains the word "laptop", you scan every row. With 10 million rows, that's 10 million comparisons.

An inverted index flips the structure:

```
Traditional (forward) index:
  Doc 1 → "Laptop computer with 16GB RAM"
  Doc 2 → "Gaming laptop, thin design"
  Doc 3 → "Computer monitor 4K"

Inverted index:
  "laptop"   → [Doc 1, Doc 2]
  "computer" → [Doc 1, Doc 3]
  "gaming"   → [Doc 2]
  "16gb"     → [Doc 1]
  "ram"      → [Doc 1]
  "monitor"  → [Doc 3]
  "4k"       → [Doc 3]
```

Now "find documents containing laptop" is a single hash lookup: O(1) to find the term, then read the posting list.

### Posting Lists

Each term in the inverted index points to a **posting list** — a sorted list of document IDs (and optionally: term frequency, position, offsets).

```
"laptop" → postings: [
  { doc_id: 1, tf: 1, positions: [0] },
  { doc_id: 2, tf: 1, positions: [1] }
]
```

- **doc_id**: which document contains this term
- **tf (term frequency)**: how many times it appears (used for scoring)
- **positions**: where in the document (used for phrase queries like `"gaming laptop"`)
- **offsets**: character positions (used for highlighting)

Storing positions and offsets costs space. This is why Elasticsearch lets you configure `index_options` per field:

```json
"title": {
  "type": "text",
  "index_options": "docs"       // only doc IDs (smallest)
  "index_options": "freqs"      // + term frequency
  "index_options": "positions"  // + positions (default)
  "index_options": "offsets"    // + character offsets (largest)
}
```

## Text Analysis Pipeline

Before text lands in the inverted index, it goes through an **analyzer**. An analyzer has three components:

```
Raw text: "Quick Brown Fox Jumped!"
              │
    ┌─────────▼──────────┐
    │ Character Filters   │  (optional — transform raw chars)
    │ e.g. HTML stripping │
    └─────────┬──────────┘
              │ "Quick Brown Fox Jumped!"
    ┌─────────▼──────────┐
    │ Tokenizer           │  (split into tokens)
    │ e.g. standard       │
    └─────────┬──────────┘
              │ ["Quick", "Brown", "Fox", "Jumped"]
    ┌─────────▼──────────┐
    │ Token Filters       │  (transform tokens)
    │ lowercase, stop,    │
    │ stemming, synonyms  │
    └─────────┬──────────┘
              │ ["quick", "brown", "fox", "jump"]
              ▼
        Inverted Index
```

### Built-in Analyzers

Elasticsearch ships with several ready-made analyzers:

| Analyzer | What it does |
|---|---|
| `standard` | Tokenizes on word boundaries, lowercases, removes punctuation |
| `simple` | Splits on non-letters, lowercases |
| `whitespace` | Splits on whitespace only (no lowercasing) |
| `stop` | Like `simple` but removes English stopwords |
| `english` | Stemming, stopwords, possessive removal |
| `keyword` | No analysis — treats entire field value as one token |

**This is why matching fails silently.** If you index with the `standard` analyzer and search with it, `"Quick Brown Fox"` and `"quick brown fox"` both tokenize to `["quick", "brown", "fox"]` — they match. But if your field uses the `whitespace` analyzer, `"Quick Brown Fox"` stays as `["Quick", "Brown", "Fox"]` and a query for `"quick"` (lowercase) finds nothing.

## Hands-On: Inspecting Analysis

The `_analyze` API lets you see exactly what tokens will be stored.

```bash
# What does the standard analyzer do with this text?
curl -X POST "localhost:9200/_analyze" -H 'Content-Type: application/json' -d '
{
  "analyzer": "standard",
  "text": "Quick Brown Fox Jumped! He was running fast."
}'
```

Response:
```json
{
  "tokens": [
    { "token": "quick",   "start_offset": 0,  "end_offset": 5,  "type": "<ALPHANUM>", "position": 0 },
    { "token": "brown",   "start_offset": 6,  "end_offset": 11, "type": "<ALPHANUM>", "position": 1 },
    { "token": "fox",     "start_offset": 12, "end_offset": 15, "type": "<ALPHANUM>", "position": 2 },
    { "token": "jumped",  "start_offset": 16, "end_offset": 22, "type": "<ALPHANUM>", "position": 3 },
    { "token": "he",      "start_offset": 24, "end_offset": 26, "type": "<ALPHANUM>", "position": 4 },
    { "token": "was",     "start_offset": 27, "end_offset": 30, "type": "<ALPHANUM>", "position": 5 },
    { "token": "running", "start_offset": 31, "end_offset": 38, "type": "<ALPHANUM>", "position": 6 },
    { "token": "fast",    "start_offset": 39, "end_offset": 43, "type": "<ALPHANUM>", "position": 7 }
  ]
}
```

Now try the `english` analyzer — it stems words:

```bash
curl -X POST "localhost:9200/_analyze" -H 'Content-Type: application/json' -d '
{
  "analyzer": "english",
  "text": "Quick Brown Fox Jumped! He was running fast."
}'
```

Response:
```json
{
  "tokens": [
    { "token": "quick",  "position": 0 },
    { "token": "brown",  "position": 1 },
    { "token": "fox",    "position": 2 },
    { "token": "jump",   "position": 3 },
    { "token": "run",    "position": 6 },
    { "token": "fast",   "position": 7 }
  ]
}
```

Key differences with `english`:
- `"jumped"` → `"jump"` (stemmed)
- `"running"` → `"run"` (stemmed)
- `"He"`, `"was"` removed (stopwords)

With the `english` analyzer, a query for `"run"` matches documents containing `"running"`, `"ran"`, `"runs"`. With `standard`, it only matches exact token `"run"`.

## Custom Analyzers

You can compose your own analyzer from any combination of components:

```bash
curl -X PUT "localhost:9200/products" -H 'Content-Type: application/json' -d '
{
  "settings": {
    "analysis": {
      "filter": {
        "my_synonym_filter": {
          "type": "synonym",
          "synonyms": [
            "laptop, notebook, portable computer",
            "phone, mobile, smartphone"
          ]
        }
      },
      "analyzer": {
        "my_product_analyzer": {
          "type": "custom",
          "tokenizer": "standard",
          "filter": [
            "lowercase",
            "stop",
            "my_synonym_filter",
            "snowball"
          ]
        }
      }
    }
  },
  "mappings": {
    "properties": {
      "title": {
        "type": "text",
        "analyzer": "my_product_analyzer"
      }
    }
  }
}'
```

Test what this analyzer does:

```bash
curl -X POST "localhost:9200/products/_analyze" -H 'Content-Type: application/json' -d '
{
  "analyzer": "my_product_analyzer",
  "text": "MacBook Pro Laptop 16-inch"
}'
```

```json
{
  "tokens": [
    { "token": "macbook",  "position": 0 },
    { "token": "pro",      "position": 1 },
    { "token": "laptop",   "position": 2 },
    { "token": "notebook", "position": 2 },    ← synonym expansion
    { "token": "portabl",  "position": 2 },    ← stemmed "portable"
    { "token": "comput",   "position": 2 },    ← stemmed "computer" (from synonym)
    { "token": "16",       "position": 3 },
    { "token": "inch",     "position": 4 }
  ]
}
```

A search for `"notebook"` now finds documents that only contain `"laptop"` — and vice versa.

## Multi-Field Mappings: The search_as_you_type Pattern

A common pattern is to store the same field in multiple ways for different query types:

```bash
curl -X PUT "localhost:9200/products" -H 'Content-Type: application/json' -d '
{
  "mappings": {
    "properties": {
      "title": {
        "type": "text",
        "analyzer": "english",
        "fields": {
          "keyword": {
            "type": "keyword"       ← exact match, sorting, aggregations
          },
          "autocomplete": {
            "type": "search_as_you_type"   ← prefix matching
          }
        }
      }
    }
  }
}'
```

Now `title` (text, analyzed for full-text), `title.keyword` (exact, for facets), and `title.autocomplete` (prefix, for suggest-as-you-type) all exist for the same data.

## Inspecting What's Actually in the Index

After indexing documents, use `_termvectors` to see the exact tokens stored:

```bash
# Index a document first
curl -X POST "localhost:9200/products/_doc/1" -H 'Content-Type: application/json' -d '
{
  "title": "Gaming Laptop — Thin Design, 16GB RAM"
}'

# Inspect its term vectors
curl -X GET "localhost:9200/products/_termvectors/1" -H 'Content-Type: application/json' -d '
{
  "fields": ["title"],
  "offsets": true,
  "positions": true,
  "term_statistics": true
}'
```

Response (abbreviated):
```json
{
  "term_vectors": {
    "title": {
      "terms": {
        "16gb": { "term_freq": 1, "tokens": [{"position": 4}] },
        "design": { "term_freq": 1, "tokens": [{"position": 3}] },
        "gaming": { "term_freq": 1, "tokens": [{"position": 0}] },
        "laptop": { "term_freq": 1, "tokens": [{"position": 1}] },
        "ram":    { "term_freq": 1, "tokens": [{"position": 5}] },
        "thin":   { "term_freq": 1, "tokens": [{"position": 2}] }
      }
    }
  }
}
```

This is the ground truth of what's searchable. If a token isn't in `_termvectors`, no query will find this document via that token.

## Search-Time vs Index-Time Analysis

Analysis happens in two places:
- **Index time**: when a document is indexed (what goes into the inverted index)
- **Search time**: when a query is run (what the query terms become before lookup)

By default, Elasticsearch uses the same analyzer for both — which is almost always what you want. Mismatches cause invisible bugs:

```json
// Index with standard analyzer → tokens: ["running"]
// Query with whitespace analyzer → token: "Running" (not lowercased)
// Result: no match, even though the document has "running"
```

You can set separate analyzers explicitly:

```json
"title": {
  "type": "text",
  "analyzer": "english",
  "search_analyzer": "standard"
}
```

Use this carefully. The most common legitimate use is synonym expansion: expand synonyms at index time so queries don't need to know about them.

## Practical Implications

**Implication 1: You can't change the analyzer after indexing.**

The inverted index is built at index time. If you change the analyzer, old documents have the old tokens and new documents have new tokens — your index is inconsistent. The solution: reindex into a new index with the new mapping, then use an alias to swap.

```bash
# Create new index with corrected analyzer
# Reindex old → new
curl -X POST "localhost:9200/_reindex" -H 'Content-Type: application/json' -d '
{
  "source": { "index": "products_v1" },
  "dest":   { "index": "products_v2" }
}'

# Swap alias (atomic, zero downtime)
curl -X POST "localhost:9200/_aliases" -H 'Content-Type: application/json' -d '
{
  "actions": [
    { "remove": { "index": "products_v1", "alias": "products" } },
    { "add":    { "index": "products_v2", "alias": "products" } }
  ]
}'
```

**Implication 2: `keyword` fields are never analyzed.**

A `keyword` field stores the exact string. `"Gaming Laptop"` is indexed as the single token `"Gaming Laptop"`. A query for `"gaming"` (lowercase, no capital) returns nothing. Use `keyword` for IDs, status fields, tags, and aggregations. Use `text` for free-form search.

**Implication 3: Language matters.**

The `english` stemmer knows nothing about French, German, or Chinese. For multilingual content, you need language-specific analyzers per language, and you need to know which language a document is in at index time.

## Key Takeaways

- **Inverted index** maps tokens → posting lists (doc IDs, term frequency, positions).
- **Analyzers** transform raw text into tokens. The `standard` analyzer lowercases and splits on word boundaries. The `english` analyzer also stems and removes stopwords.
- **Analysis happens at both index time and search time.** They must match or queries silently return wrong results.
- **`_analyze` API** is your primary tool for understanding and debugging analysis behavior.
- **`_termvectors` API** shows you the exact tokens stored for a specific document.
- **Multi-fields** let you store the same text in multiple analyzed forms for different query types.
- **You can't change analyzers without reindexing.** Plan your mapping before you index production data.

## Next Steps

You now understand how text becomes tokens and how those tokens live in the inverted index. But Elasticsearch doesn't have one big inverted index per field — it has many. Each shard has its own Lucene index, and each Lucene index is made up of multiple **segments**.

Understanding segments explains one of Elasticsearch's most surprising behaviors: why documents you just indexed aren't immediately searchable.

---

**Part 1 complete. Next: [Shards, Segments & Lucene](/blog/es-series-2-shards-segments/)**
