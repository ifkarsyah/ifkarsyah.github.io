---
title: "ClickHouse Series, Part 4: Internals — Parts, Merges & Indexes"
description: "How ClickHouse actually stores data — parts, granules, the sparse primary index, data-skipping indexes, and the background merge process."
pubDate: 2024-06-30
author: "ifkarsyah"
domain: "Analytics"
stack: ["ClickHouse"]
image:
  src: ./clickhouse-series.png
  alt: "ClickHouse Internals Parts Merges Indexes"
---

## Why Internals Matter

Understanding how ClickHouse stores and retrieves data is what separates a schema that is fast from one that merely works. Once you understand parts, granules, and the sparse index, the advice from earlier parts — put low-cardinality columns first in ORDER BY, avoid over-partitioning, batch your inserts — becomes obvious rather than arbitrary.

## Parts

Every insert into a MergeTree table creates a **part**: a directory on disk containing one file per column, plus metadata. Parts are immutable once written.

```
/var/lib/clickhouse/data/default/events/
├── 20240101_1_1_0/       ← part directory
│   ├── date.bin          ← compressed column data
│   ├── date.mrk2         ← marks file (index into column data)
│   ├── user_id.bin
│   ├── user_id.mrk2
│   ├── event_type.bin
│   ├── event_type.mrk2
│   ├── primary.idx       ← sparse primary index
│   └── columns.txt       ← schema metadata
├── 20240101_2_2_0/
└── 20240101_1_2_1/       ← merged part (covers range 1–2)
```

The part name encodes the partition key, min block number, max block number, and merge level. `20240101_1_2_1` means: partition `20240101`, covering blocks 1 through 2, merged once.

## Granules

Within each part, data is divided into **granules** — the minimum unit of data ClickHouse reads. The default granule size is 8,192 rows.

Each `.bin` file (column data) is split into granule-sized chunks. The `.mrk2` marks file records the byte offset of each granule in the `.bin` file. When ClickHouse needs to read granule 5 of a column, it seeks directly to the byte offset without scanning from the start.

```
Column: user_id.bin

Granule 0: rows 0–8191    → byte offset 0
Granule 1: rows 8192–16383 → byte offset 4096
Granule 2: rows 16384–24575 → byte offset 7680
...
```

The granule is the atomic read unit: ClickHouse either reads an entire granule or skips it entirely. This is why the index granularity and sort order matter so much for performance.

## Sparse Primary Index

ClickHouse does not store an index entry for every row. Instead, it stores one index entry per granule — this is the **sparse primary index** (`primary.idx`).

For a table with `ORDER BY (event_type, user_id, date)`, the sparse index stores the first row of each granule:

```
primary.idx:

Granule 0:  ('click',    user-0,    2024-01-01)
Granule 1:  ('click',    user-8192, 2024-01-01)
Granule 2:  ('purchase', user-0,    2024-01-01)
Granule 3:  ('purchase', user-4096, 2024-01-02)
...
```

When you query `WHERE event_type = 'purchase'`, ClickHouse binary-searches the primary index to find which granules can contain `'purchase'`. Granules 0–1 contain only `'click'` rows — they are skipped entirely. Only granules 2–N are read.

This is **granule skipping**: the primary mechanism for fast queries in ClickHouse. A well-chosen ORDER BY key means most granules are skipped for typical queries.

## Data-Skipping Indexes

The sparse primary index only helps for columns in the ORDER BY key. For filtering on other columns, ClickHouse supports **data-skipping indexes** (secondary indexes).

### minmax

Stores the min and max value of a column per granule block. Skips blocks where the queried value falls outside the range.

```sql
ALTER TABLE events ADD INDEX idx_timestamp timestamp TYPE minmax GRANULARITY 4;
```

`GRANULARITY 4` means the index covers 4 granules at a time (4 × 8192 = 32,768 rows per index entry). Good for: monotonically increasing columns like timestamps that the ORDER BY key doesn't start with.

### set

Stores the set of distinct values per granule block. Skips blocks that do not contain the queried value.

```sql
ALTER TABLE events ADD INDEX idx_country country TYPE set(100) GRANULARITY 1;
```

`set(100)` means the index is valid when the granule has ≤ 100 distinct values; if a block has more, the index is not used. Good for: low-cardinality columns not in the ORDER BY key.

### bloom_filter

Probabilistic index using a Bloom filter. Skips blocks that definitely do not contain the queried value (with configurable false-positive rate).

```sql
ALTER TABLE events ADD INDEX idx_session session_id TYPE bloom_filter(0.01) GRANULARITY 1;
```

Good for: high-cardinality string columns (UUIDs, session IDs, URLs) with equality predicates.

### tokenbf_v1 and ngrambf_v1

Bloom filter variants that index individual tokens (words) or n-grams within string values. Useful for `LIKE` and substring search queries on free-text columns.

```sql
ALTER TABLE logs ADD INDEX idx_message message TYPE tokenbf_v1(32768, 3, 0) GRANULARITY 1;
```

## Background Merges

ClickHouse runs background **merge** threads that continuously consolidate small parts into larger ones. This is where the "Merge" in MergeTree comes from.

Merges serve several purposes:
- Reduce part count (too many parts = slower queries and metadata overhead)
- Apply engine-specific logic: deduplication (ReplacingMergeTree), aggregation (SummingMergeTree), TTL expiration
- Re-sort data within merged parts for better compression

You can observe merges in progress:

```sql
SELECT table, elapsed, progress, rows_read, rows_written
FROM system.merges
ORDER BY elapsed DESC;
```

And check the current part health:

```sql
SELECT
    partition,
    count()           AS parts,
    sum(rows)         AS rows,
    sum(bytes_on_disk) AS bytes
FROM system.parts
WHERE active AND table = 'events'
GROUP BY partition
ORDER BY partition;
```

**Too many parts** is a common sign of over-inserting in small batches. ClickHouse will eventually throw `Too many parts (N). Merges are processing significantly slower than inserts` and reject new inserts until merges catch up.

You can manually trigger a merge (useful after bulk loads):

```sql
OPTIMIZE TABLE events PARTITION '202401';    -- merge one partition
OPTIMIZE TABLE events FINAL;                  -- merge everything into one part per partition (slow)
```

## Shards and Distributed Tables

In a multi-node cluster, data is split across **shards**. Each shard holds a subset of the rows. A **Distributed table** is a virtual table that routes queries to all shards and merges results:

```sql
-- On each node, a local MergeTree table
CREATE TABLE events_local (
    ...
) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/events', '{replica}')
ORDER BY (event_type, user_id, date);

-- Distributed table that wraps the local tables
CREATE TABLE events AS events_local
ENGINE = Distributed('my_cluster', 'default', 'events_local', rand());
```

`rand()` is the sharding key — rows are distributed randomly across shards. You can use a deterministic key (e.g., `cityHash64(user_id)`) to ensure all rows for a user land on the same shard, enabling shard-local aggregations without cross-shard joins.

Writes go to the Distributed table and are forwarded to the appropriate shard. Reads fan out to all shards and results are merged on the coordinator.

## Key Takeaways

- Every insert creates an immutable **part**; background merges consolidate parts over time
- Data within a part is divided into **granules** (8,192 rows) — the atomic read unit
- The **sparse primary index** stores one entry per granule, enabling fast binary search over ORDER BY columns
- **Data-skipping indexes** (minmax, set, bloom_filter) extend skipping to non-ORDER BY columns
- Merges apply engine logic (deduplication, aggregation, TTL) and must keep pace with inserts
- **Distributed tables** fan out queries across shards; the sharding key determines data locality

Next: Query Optimization — profiling slow queries, projections, and design patterns for sub-second analytics.
