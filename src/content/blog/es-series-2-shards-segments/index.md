---
title: "Elasticsearch Internals Series, Part 2: Shards, Segments & Lucene"
description: "How Elasticsearch splits indexes into shards, how each shard is a Lucene index made of immutable segments, and why refresh interval controls search freshness."
pubDate: 2026-03-09
author: "ifkarsyah"
domain: "Search"
stack: ["Elasticsearch"]
image:
  src: ./es-series.png
  alt: "Elasticsearch Shards and Segments"
---

You index a document. You immediately search for it. It's not there.

This surprises most Elasticsearch newcomers. The data was accepted (HTTP 200, `"result": "created"`), but the search returns nothing. Wait a second and search again — now it appears.

The explanation lives in the shard and segment architecture. Understanding it turns this mysterious behavior into something completely predictable.

## The Hierarchy: Index → Shard → Segment

Elasticsearch's storage model has three layers:

```
Elasticsearch Index ("products")
├── Shard 0  (primary)          ← a complete Lucene index
│   ├── Segment 0  (immutable)
│   ├── Segment 1  (immutable)
│   ├── Segment 2  (immutable, being merged)
│   └── In-memory buffer        ← pending writes not yet a segment
├── Shard 1  (primary)
│   └── ...
└── Shard 2  (primary)
    └── ...
```

**An Elasticsearch index** is a logical namespace that routes documents to shards based on document ID.

**A shard** is a fully self-contained Lucene index. It can answer queries on its own. Shards are the unit of distribution — Elasticsearch moves shards between nodes to balance load.

**A segment** is a Lucene segment: an immutable, self-contained mini-index. Each segment has its own inverted index, `doc_values`, stored fields (`_source`), and term dictionary. Once written, a segment never changes.

## Shard Routing

When you index `PUT /products/_doc/42`, how does Elasticsearch decide which shard to put it on?

```
shard = hash(document_id) % number_of_primary_shards
```

This formula is why you **cannot change the number of primary shards after index creation** — the routing would break for all existing documents. (The `_split` and `_shrink` APIs work around this with whole-number multiples, but the routing formula stays.)

**Custom routing:**

```bash
curl -X PUT "localhost:9200/products/_doc/42?routing=category_a" -H 'Content-Type: application/json' -d '
{ "title": "Laptop", "category": "category_a" }'
```

Useful for co-locating related documents on the same shard (join patterns, parent-child relationships).

Check which shard a document lives on:

```bash
curl -X GET "localhost:9200/products/_search_shards" -H 'Content-Type: application/json' -d '
{ "routing": "42" }'
```

## The Segment Lifecycle

Documents don't go directly into a segment. The write flow is:

```
Index Request
     │
     ▼
In-memory indexing buffer  ←── writes accumulate here
     │
     │  (every refresh_interval, default 1s)
     ▼
New Segment  ←── buffer flushed to a new Lucene segment on disk
     │
     │  (segment merge — background process)
     ▼
Merged Segment  ←── smaller segments merged into larger ones
```

### Why Segments Are Immutable

Lucene segments are immutable because mutability is expensive. To "update" a document:
1. Mark the old document as **deleted** (flip a bit in a deletion bitmap)
2. Write the new version as a new document in a new segment

The old document's data is still on disk — it's just marked deleted and invisible to searches. Physical deletion only happens during **segment merges**, when the merged segment omits deleted documents.

This explains why deletes and updates don't free disk space immediately.

### Refresh: Making Documents Searchable

The **refresh** operation creates a new Lucene segment from the in-memory buffer. Only after a refresh can documents be found by search.

Default refresh interval: **1 second**.

```bash
# Check current refresh interval
curl -X GET "localhost:9200/products/_settings?pretty" | grep refresh

# Change refresh interval
curl -X PUT "localhost:9200/products/_settings" -H 'Content-Type: application/json' -d '
{ "index": { "refresh_interval": "5s" } }'

# Disable refresh (bulk indexing — maximizes throughput)
curl -X PUT "localhost:9200/products/_settings" -H 'Content-Type: application/json' -d '
{ "index": { "refresh_interval": "-1" } }'

# Force an immediate refresh
curl -X POST "localhost:9200/products/_refresh"
```

**The cost of more frequent refreshes:** Each refresh creates a new segment. More segments = more work for searches (searches must look across all segments) and more background merge work.

**The cost of less frequent refreshes:** Documents are not searchable until the next refresh. In a bulk loading scenario, setting `refresh_interval: -1` during the load, then calling `_refresh` at the end, is a major throughput optimization.

### Flush: Persisting to Disk

**Refresh** creates a new segment, but that segment may still be in the OS filesystem cache — not necessarily fsynced to durable storage. A **flush** calls `fsync` and clears the translog (we'll cover the translog in Part 8).

```bash
# Force a flush
curl -X POST "localhost:9200/products/_flush"
```

Flush happens automatically when the translog reaches a configured size (default 512MB) or after 30 minutes. You rarely need to call it manually.

## Hands-On: Watching Segments

```bash
# First, create an index and index some documents
curl -X PUT "localhost:9200/products" -H 'Content-Type: application/json' -d '
{
  "settings": {
    "number_of_shards": 3,
    "number_of_replicas": 0,
    "refresh_interval": "60s"
  }
}'

curl -X POST "localhost:9200/products/_bulk" -H 'Content-Type: application/json' -d '
{ "index": { "_id": "1" } }
{ "title": "Laptop Pro", "price": 1299 }
{ "index": { "_id": "2" } }
{ "title": "Gaming Mouse", "price": 59 }
{ "index": { "_id": "3" } }
{ "title": "Mechanical Keyboard", "price": 149 }
'
```

Check segments before refresh:

```bash
curl -X GET "localhost:9200/products/_segments?pretty"
```

You'll see 0 segments (or only pre-existing ones from a previous refresh) because the documents are still in the buffer.

Force a refresh, then check again:

```bash
curl -X POST "localhost:9200/products/_refresh"
curl -X GET "localhost:9200/products/_segments?pretty"
```

Now you'll see new segments appeared:

```json
{
  "indices": {
    "products": {
      "shards": {
        "0": [{
          "segments": {
            "_0": {
              "generation": 0,
              "num_docs": 1,
              "deleted_docs": 0,
              "size_in_bytes": 3567,
              "committed": false,
              "search": true,
              "version": "9.10.0"
            }
          }
        }]
      }
    }
  }
}
```

- `committed: false` — not yet fsynced (will survive process crash but not OS crash until flush)
- `search: true` — searchable
- `num_docs: 1` — this shard got 1 document (distributed by routing)

Index more batches and watch multiple segments accumulate:

```bash
# Index 3 more batches with manual refresh between each
for i in 1 2 3; do
  curl -s -X POST "localhost:9200/products/_doc" -H 'Content-Type: application/json' \
    -d "{\"title\": \"Product $i\", \"price\": $((i * 100))}" > /dev/null
  curl -s -X POST "localhost:9200/products/_refresh" > /dev/null
done

# Now check segment count — should see multiple segments per shard
curl -X GET "localhost:9200/_cat/segments/products?v"
```

## Segment Merges

Left unchecked, segments accumulate. A shard with 1000 segments must check all 1000 for each query. Lucene's **merge policy** periodically merges small segments into larger ones.

```
Before merge:                       After merge:
  Segment 0 (100 docs)                Segment 3 (550 docs)
  Segment 1 (150 docs)       →        Segment 2 (300 docs, unchanged)
  Segment 2 (300 docs)
  Segment 3 (200 deleted docs)        ← deleted docs are dropped
```

Merging is CPU and I/O intensive. Elasticsearch runs merges in the background, throttled to not overwhelm the indexing pipeline.

**Monitor merge activity:**

```bash
curl -X GET "localhost:9200/_cat/nodes?v&h=name,merges.current,merges.total,merges.total_size"
```

**Force a merge** (useful after large deletes or bulk loads):

```bash
# Merge down to 1 segment (expensive — don't do this on a live write-heavy index)
curl -X POST "localhost:9200/products/_forcemerge?max_num_segments=1"
```

After a force merge, searches are faster (single segment to scan), but disk usage spikes during the merge and no new merges can happen until it finishes.

## `_cat/shards`: Your Shard Overview

```bash
curl -X GET "localhost:9200/_cat/shards/products?v&h=index,shard,prirep,state,docs,store,node"
```

```
index     shard prirep state   docs store node
products  0     p      STARTED    2 8.1kb es01
products  1     p      STARTED    1 5.2kb es01
products  2     p      STARTED    3 9.4kb es01
```

- `prirep`: `p` = primary, `r` = replica
- `state`: `STARTED`, `INITIALIZING`, `RELOCATING`, `UNASSIGNED`

Unassigned replicas appear when there aren't enough nodes to host them. In a single-node cluster with `number_of_replicas: 1`, all replicas will be `UNASSIGNED` and the cluster health will be **yellow**.

## Shard Sizing

How many shards should you have? There's no single right answer, but rough guidelines:

| Signal | Guideline |
|---|---|
| Shard count | 10–50 GB per shard is a common sweet spot |
| Too many small shards | Overhead of coordinating 1000 shards on every query |
| Too few large shards | Can't distribute data across nodes; slow merges |
| Write throughput | More primary shards = more parallel write paths |
| Search throughput | More shards = more parallelism per query (up to node count) |

Check current shard sizes:

```bash
curl -X GET "localhost:9200/_cat/shards?v&h=index,shard,prirep,store&s=store:desc"
```

## Practical Impact

**Refresh interval directly trades freshness for throughput.** For a logging pipeline where 5-second delay is fine, set `refresh_interval: 5s`. For a customer-facing search where near-real-time matters, keep the default 1s.

**Segment count affects query speed.** After a bulk delete of 50% of an index, the data is gone logically but the disk space and segments remain. A `_forcemerge` cleans it up.

**Primary shard count is immutable.** Decide before you go to production. For indexes that grow, plan with `_rollover` (time-based rolling indexes) instead of trying to resize a single large index.

## Key Takeaways

- **Documents live in segments**, which live in shards, which live in an Elasticsearch index.
- **Segments are immutable.** Updates mark old docs deleted and write new docs; merges clean up.
- **Refresh (default 1s)** flushes the in-memory buffer to a new searchable segment. This is why new docs take ~1s to appear in search.
- **Flush** fsyncs segments to disk and clears the translog. It's about durability, not searchability.
- **Merges** consolidate small segments and purge deleted docs in the background.
- **Primary shard count cannot be changed** after index creation — plan it upfront.

## Next Steps

We've seen how documents flow into segments. But what exactly is stored in each segment? Beyond the inverted index, Elasticsearch stores multiple representations of each field — each optimized for a different access pattern. That's the subject of mappings and document storage.

---

**Part 2 complete. Next: [Document Storage & Mappings](/blog/es-series-3-mappings-storage/)**
