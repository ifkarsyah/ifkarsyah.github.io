---
title: "Elasticsearch Internals Series, Part 8: Write Path & Translog"
description: "The complete lifecycle of a write — from index request to durable disk storage. Translog as Elasticsearch's WAL, refresh vs flush, and tuning durability vs throughput."
pubDate: 2026-04-20
author: "ifkarsyah"
domain: "Search"
stack: ["Elasticsearch"]
image:
  src: ./es-series.png
  alt: "Elasticsearch Write Path and Translog"
---

When you send `PUT /products/_doc/42`, what actually happens? The document needs to be searchable, durable, and consistent — but achieving all three simultaneously would make writes unbearably slow.

Elasticsearch solves this with a layered write architecture: an in-memory buffer for speed, a write-ahead log (the translog) for durability, and a background merge process for efficiency. Understanding this architecture lets you make the right tradeoffs for your workload.

## The Complete Write Lifecycle

```
PUT /products/_doc/42 { "title": "Gaming Laptop" }
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│ 1. TRANSLOG WRITE (fsync, if sync durability)               │
│    Write operation appended to translog                     │
│    Durable on disk. Survives process crash.                 │
└────────────────────────┬────────────────────────────────────┘
                         │ simultaneously
┌────────────────────────▼────────────────────────────────────┐
│ 2. INDEXING BUFFER (in-memory)                              │
│    Document added to Lucene indexing buffer                 │
│    NOT yet searchable.                                      │
└────────────────────────┬────────────────────────────────────┘
                         │ HTTP 200 returned to client here
                         │
                         │ (every refresh_interval, default 1s)
┌────────────────────────▼────────────────────────────────────┐
│ 3. REFRESH                                                  │
│    Buffer flushed → new Lucene segment created              │
│    Document is NOW SEARCHABLE.                              │
│    Segment may still be in OS page cache (not fsynced)      │
└────────────────────────┬────────────────────────────────────┘
                         │
                         │ (every 30min or when translog hits 512MB)
┌────────────────────────▼────────────────────────────────────┐
│ 4. FLUSH                                                    │
│    All segments fsynced to disk                             │
│    Translog checkpoint updated                              │
│    Old translog entries truncated (no longer needed)        │
└─────────────────────────────────────────────────────────────┘
```

The client gets HTTP 200 after step 2 — the document is in the translog and the indexing buffer, but not yet searchable.

## The Translog: Elasticsearch's Write-Ahead Log

The translog is a sequential append-only log written before every change. Its purpose: **crash recovery**.

If the Elasticsearch process crashes after step 2 but before step 3 (refresh), the document is in the translog. On restart, Elasticsearch replays the translog to reconstruct the in-memory indexing buffer — no data loss.

If the OS crashes (power failure), what happens depends on the `translog.durability` setting.

### Translog Durability Settings

```bash
# Per-index setting
curl -X PUT "localhost:9200/products/_settings" -H 'Content-Type: application/json' -d '
{
  "index": {
    "translog": {
      "durability": "request",    ← fsync on every write (default)
      "sync_interval": "5s"       ← only used when durability is "async"
    }
  }
}'
```

| Setting | Behavior | Durability | Throughput |
|---|---|---|---|
| `request` (default) | fsync translog after every write | Survives OS crash | Lower |
| `async` | fsync translog every `sync_interval` (default 5s) | May lose up to 5s of writes on OS crash | Higher |

**For most production use cases:** `request` is correct. The performance difference is smaller than you'd expect because Elasticsearch batches multiple translog writes in a single fsync using group commit (similar to PostgreSQL's WAL).

**For bulk loading, logging, or write-heavy analytics where losing a few seconds of data is acceptable:** `async` with `sync_interval: 5s` can significantly increase throughput.

### Translog on Disk

```bash
# Find the translog on disk (default data path: /var/lib/elasticsearch)
ls /var/lib/elasticsearch/nodes/0/indices/<index-uuid>/<shard-id>/translog/

# Typical contents:
# translog-1.tlog    ← active translog
# translog-1.ckp     ← checkpoint (tracks committed position)
```

The checkpoint file records the last fsynced position. On restart, Elasticsearch replays from the checkpoint forward.

## Refresh: Searchability vs Throughput

The refresh interval (default 1 second) is the primary control for search freshness vs write throughput.

**What happens during a refresh:**
1. Lucene writes the in-memory buffer to a new segment file
2. The segment becomes visible to search
3. A new empty buffer starts accumulating

Each refresh creates a new small segment. Many small segments = more merge work.

### Tuning Refresh for Bulk Loading

For batch data loading where near-real-time search is not needed:

```bash
# Before bulk load
curl -X PUT "localhost:9200/products/_settings" -H 'Content-Type: application/json' -d '
{
  "index": {
    "refresh_interval": "-1",               ← disable refresh
    "number_of_replicas": 0                 ← disable replicas (no replication overhead)
  }
}'

# Do your bulk indexing
curl -X POST "localhost:9200/products/_bulk" --data-binary @large_dataset.ndjson

# After bulk load: re-enable and force refresh
curl -X PUT "localhost:9200/products/_settings" -H 'Content-Type: application/json' -d '
{
  "index": {
    "refresh_interval": "1s",
    "number_of_replicas": 1
  }
}'
curl -X POST "localhost:9200/products/_refresh"
```

This is one of the most impactful optimizations for bulk loading. Disabling refresh during loading means no segments are created mid-load — one large refresh at the end creates optimally-sized segments.

### Refresh API

Force an immediate refresh (useful after writes in tests):

```bash
curl -X POST "localhost:9200/products/_refresh"
```

Or refresh all indexes:

```bash
curl -X POST "localhost:9200/_refresh"
```

### `refresh=wait_for`

For cases where you need to index a document and immediately search for it:

```bash
curl -X PUT "localhost:9200/products/_doc/1?refresh=wait_for" -H 'Content-Type: application/json' -d '
{ "title": "Laptop" }'
# → HTTP 200 returned only AFTER the next refresh completes
# → Document is now searchable
```

`refresh=true` also exists — triggers an immediate refresh before responding. Avoid in production hot paths (creates a segment per document write).

## Flush: Durability without Translog Bloat

The flush operation:
1. Triggers a refresh (creates segments from buffer)
2. fsyncs all segments to durable storage
3. Writes a checkpoint to the translog
4. Truncates old translog entries (they're no longer needed for recovery)

Without periodic flushes, the translog grows indefinitely. On restart, Elasticsearch would need to replay the entire translog history.

**Flush is triggered automatically when:**
- `index.translog.flush_threshold_size` is reached (default 512MB)
- `index.translog.flush_threshold_period` elapses (default 30 minutes)

Manual flush:

```bash
curl -X POST "localhost:9200/products/_flush"
curl -X POST "localhost:9200/products/_flush?wait_if_ongoing=true"  ← wait if flush already running
```

## Segment Merges and Write Amplification

Every refresh creates a new small segment. Over time, many small segments accumulate. Lucene's TieredMergePolicy merges segments in tiers:

```
Initial segments (after 10 refreshes):
  seg0: 100 docs
  seg1: 100 docs
  seg2:  80 docs
  ...
  seg9:  90 docs

After a merge:
  seg10: 950 docs  ← merged from seg0-seg9
```

**Write amplification**: Each byte written eventually gets rewritten multiple times as segments merge into larger segments. For a document indexed once, it may be physically written 3-5 times before ending up in a large final segment.

Monitor merge activity:

```bash
curl -X GET "localhost:9200/_nodes/stats/indices/merges?pretty"
```

Tune merge throttling (default 20 MB/s per node):

```bash
curl -X PUT "localhost:9200/_cluster/settings" -H 'Content-Type: application/json' -d '
{
  "transient": {
    "indices.store.throttle.max_bytes_per_sec": "100mb"
  }
}'
```

## The Bulk API

For high-throughput indexing, always use the Bulk API instead of individual document requests.

```bash
curl -X POST "localhost:9200/_bulk" -H 'Content-Type: application/json' --data-binary '
{ "index": { "_index": "products", "_id": "1" } }
{ "title": "Laptop", "price": 1299 }
{ "index": { "_index": "products", "_id": "2" } }
{ "title": "Mouse", "price": 49 }
{ "update": { "_index": "products", "_id": "1" } }
{ "doc": { "price": 1199 } }
{ "delete": { "_index": "products", "_id": "2" } }
'
```

**Why bulk is faster:**
- One HTTP connection, one network round trip
- One translog fsync per batch (not per document)
- One refresh creates one segment for the whole batch

**Optimal bulk size:** 5–15 MB per request is typical. Larger requests don't improve throughput and increase memory pressure. Tune with benchmarks.

## Hands-On: Comparing Write Configurations

Set up a benchmark to compare configurations:

```bash
# Create two indexes with different settings
curl -X PUT "localhost:9200/test_sync" -H 'Content-Type: application/json' -d '
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 0,
    "index.translog.durability": "request",
    "index.refresh_interval": "1s"
  }
}'

curl -X PUT "localhost:9200/test_async" -H 'Content-Type: application/json' -d '
{
  "settings": {
    "number_of_shards": 1,
    "number_of_replicas": 0,
    "index.translog.durability": "async",
    "index.translog.sync_interval": "5s",
    "index.refresh_interval": "30s"
  }
}'

# Generate test data
python3 -c "
import json, random, string
for i in range(10000):
    action = json.dumps({'index': {'_id': str(i)}})
    doc = json.dumps({'title': ''.join(random.choices(string.ascii_lowercase, k=20)), 'price': random.uniform(10, 2000)})
    print(action)
    print(doc)
" > test_data.ndjson

# Benchmark sync index
time curl -s -X POST "localhost:9200/test_sync/_bulk" -H 'Content-Type: application/json' --data-binary @test_data.ndjson > /dev/null

# Benchmark async index
time curl -s -X POST "localhost:9200/test_async/_bulk" -H 'Content-Type: application/json' --data-binary @test_data.ndjson > /dev/null
```

On typical hardware, the async+slow-refresh configuration is 2–5x faster for bulk writes.

## Monitoring the Write Path

```bash
# Indexing rate and latency
curl -X GET "localhost:9200/_cat/nodes?v&h=name,indexing.index_total,indexing.index_time,indexing.index_current"

# Refresh and flush stats
curl -X GET "localhost:9200/_stats/refresh,flush?pretty" | jq '.indices.products.total.refresh, .indices.products.total.flush'

# Translog stats
curl -X GET "localhost:9200/_stats/translog?pretty" | jq '.indices.products.total.translog'
```

Key metrics to monitor:
- `indexing.index_time / indexing.index_total` = average indexing latency
- `refresh.total_time / refresh.total` = average refresh duration
- `translog.size_in_bytes` = translog size (growing unboundedly = flush not happening)
- `merges.current` = active merges (too many = merge backlog, slowing writes)

## Key Takeaways

- **The translog is Elasticsearch's write-ahead log.** Every write goes to the translog before the indexing buffer. On crash, the translog is replayed to recover in-flight writes.
- **`translog.durability: request`** fsyncs on every write — survives OS crashes but lower throughput. **`async`** fsyncs every `sync_interval` — higher throughput, potential for data loss on OS crash.
- **Refresh (default 1s)** makes documents searchable by flushing the buffer to a new Lucene segment. It's separate from durability.
- **Flush** fsyncs segments to disk and truncates the translog. It's about preventing unbounded translog growth, not about searchability.
- **Bulk loading best practice:** disable refresh (`-1`) and replicas (`0`) during load, re-enable after. One of the biggest throughput levers available.
- **Bulk API** batches translog fsyncs, network round trips, and segment creation. Always prefer it over individual document writes.

## What You've Learned in This Series

Across 9 parts, you've traced Elasticsearch from the ground up:

1. **Inverted index & text analysis** — how raw text becomes searchable tokens
2. **Shards, segments & Lucene** — why new docs take 1s to appear, and how immutable segments work
3. **Document storage & mappings** — `_source`, `doc_values`, `fielddata`, and why the wrong mapping causes OOM
4. **Search internals & BM25** — how queries scatter across shards, gather back, and how relevance is calculated
5. **Query DSL** — filter vs query context, `bool` anatomy, deep pagination with PIT
6. **Aggregations** — bucket/metric/pipeline aggs, cardinality approximations, nested rollups
7. **Cluster architecture & replication** — master election, write replication, failure recovery
8. **Write path & translog** — the complete lifecycle from index request to durable storage

Every Elasticsearch performance problem, reliability incident, and relevance issue has a root cause in one of these layers. You now have the mental model to reason about it.

---

**Series complete.**

- [Part 0: Overview](/blog/es-series-0-overview/)
- [Part 1: Inverted Index & Text Analysis](/blog/es-series-1-inverted-index/)
- [Part 2: Shards, Segments & Lucene](/blog/es-series-2-shards-segments/)
- [Part 3: Document Storage & Mappings](/blog/es-series-3-mappings-storage/)
- [Part 4: Search Internals & Relevance Scoring](/blog/es-series-4-search-scoring/)
- [Part 5: Query DSL Deep Dive](/blog/es-series-5-query-dsl/)
- [Part 6: Aggregations & Analytics](/blog/es-series-6-aggregations/)
- [Part 7: Cluster Architecture & Replication](/blog/es-series-7-cluster-replication/)
- Part 8: Write Path & Translog ← you are here
