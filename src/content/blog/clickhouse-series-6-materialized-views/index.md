---
title: "ClickHouse Series, Part 6: Materialized Views & Operations"
description: "Pre-aggregation with materialized views, replication with ReplicatedMergeTree, sharding with Distributed tables, and production monitoring."
pubDate: 2024-07-14
author: "ifkarsyah"
tags: ["ClickHouse", "SQL", "Data Engineering"]
image:
  src: ./clickhouse-series.png
  alt: "ClickHouse Materialized Views and Operations"
---

## Materialized Views

A **materialized view** (MV) in ClickHouse is a trigger: it fires on every insert into a source table, transforms the data, and writes to a target table. Unlike views in Postgres, ClickHouse MVs do not re-read the source on query — they maintain a continuously updated result in the target table.

This makes them the primary tool for pre-aggregation: if a dashboard always needs daily active users by country, you pre-compute it incrementally as events arrive.

## Basic Pattern

```sql
-- Source: raw events
CREATE TABLE events (
    timestamp  DateTime,
    user_id    UInt64,
    country    LowCardinality(String),
    event_type LowCardinality(String)
) ENGINE = MergeTree()
PARTITION BY toDate(timestamp)
ORDER BY (event_type, user_id, timestamp);

-- Target: pre-aggregated daily counts
CREATE TABLE dau_by_country (
    date    Date,
    country LowCardinality(String),
    dau     AggregateFunction(uniq, UInt64)
) ENGINE = AggregatingMergeTree()
ORDER BY (date, country);

-- MV: fires on every insert into events
CREATE MATERIALIZED VIEW dau_by_country_mv TO dau_by_country AS
SELECT
    toDate(timestamp) AS date,
    country,
    uniqState(user_id) AS dau
FROM events
GROUP BY date, country;
```

Query the result with the `Merge` combiner:

```sql
SELECT date, country, uniqMerge(dau) AS dau
FROM dau_by_country
GROUP BY date, country
ORDER BY date, dau DESC;
```

The MV runs on the inserted batch, not on the entire table — so it only processes new data. `AggregatingMergeTree` stores intermediate HyperLogLog states that merge correctly across multiple inserts.

## SummingMergeTree Pattern

For additive metrics (counts, sums), `SummingMergeTree` is simpler than `AggregatingMergeTree`:

```sql
CREATE TABLE revenue_by_day (
    date        Date,
    country     LowCardinality(String),
    revenue     Decimal(18, 2),
    order_count UInt64
) ENGINE = SummingMergeTree()
ORDER BY (date, country);

CREATE MATERIALIZED VIEW revenue_mv TO revenue_by_day AS
SELECT
    toDate(event_at) AS date,
    country,
    sum(amount)      AS revenue,
    count()          AS order_count
FROM orders
GROUP BY date, country;
```

Query with `sum()` to handle pre-merged and not-yet-merged rows:

```sql
SELECT date, country, sum(revenue), sum(order_count)
FROM revenue_by_day
WHERE date >= today() - 30
GROUP BY date, country;
```

## Chained Materialized Views

MVs can chain: an MV writes to a table, and another MV reads from that table. This builds **aggregation pipelines**:

```sql
-- Level 1: events → hourly rollup
CREATE MATERIALIZED VIEW hourly_mv TO hourly_events AS
SELECT toStartOfHour(timestamp) AS hour, country, count() AS cnt
FROM events GROUP BY hour, country;

-- Level 2: hourly rollup → daily rollup
CREATE MATERIALIZED VIEW daily_mv TO daily_events AS
SELECT toDate(hour) AS date, country, sum(cnt) AS cnt
FROM hourly_events GROUP BY date, country;
```

Be careful with chains: if a source table has high insert rates, the chain amplifies writes. Monitor MV execution time in `system.query_log` with `query_kind = 'AsyncInsertFlush'`.

## Populating an MV on Existing Data

By default, a new MV only processes data inserted after its creation. To backfill from existing data:

```sql
-- Insert existing data from the source into the target
INSERT INTO dau_by_country
SELECT
    toDate(timestamp) AS date,
    country,
    uniqState(user_id) AS dau
FROM events
GROUP BY date, country;
```

Do this before the MV goes live, or coordinate the cutover carefully to avoid gaps.

## Replication

For production, every MergeTree table should be replicated. The `Replicated` engine variants synchronize between replicas via ZooKeeper/ClickHouse Keeper:

```sql
CREATE TABLE events (
    timestamp  DateTime,
    user_id    UInt64,
    country    LowCardinality(String)
) ENGINE = ReplicatedMergeTree(
    '/clickhouse/tables/{shard}/events',  -- ZooKeeper path (unique per shard)
    '{replica}'                            -- replica name (unique per node)
)
PARTITION BY toDate(timestamp)
ORDER BY (user_id, timestamp);
```

`{shard}` and `{replica}` are macros defined in `config.xml` per node:

```xml
<macros>
    <shard>01</shard>
    <replica>node-01</replica>
</macros>
```

Replicas sync asynchronously. A write to any replica propagates to all others. If a replica falls behind, it catches up by replaying the replication log — no manual intervention needed.

## Sharding with Distributed Tables

Sharding distributes data across multiple nodes for horizontal scale. The pattern:

```sql
-- Local table on each node (usually Replicated)
CREATE TABLE events_local AS events
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/events', '{replica}')
PARTITION BY toDate(timestamp)
ORDER BY (event_type, user_id, timestamp);

-- Distributed table: virtual, routes queries to all shards
CREATE TABLE events AS events_local
ENGINE = Distributed(
    'production_cluster',  -- cluster name from config.xml
    'default',             -- database
    'events_local',        -- local table name
    cityHash64(user_id)    -- sharding key
);
```

The **sharding key** determines which shard receives each row. `cityHash64(user_id)` distributes rows uniformly and keeps all rows for a given `user_id` on the same shard — enabling shard-local `GROUP BY user_id` without cross-shard data movement.

Use `rand()` for even distribution when locality doesn't matter.

## Monitoring

**Part count per table**: the primary health signal for write throughput.

```sql
SELECT table, partition, count() AS parts, sum(rows) AS rows
FROM system.parts
WHERE active AND database = 'default'
GROUP BY table, partition
ORDER BY parts DESC;
```

**Replication lag**: check if replicas are in sync.

```sql
SELECT database, table, replica_name, absolute_delay
FROM system.replicas
WHERE absolute_delay > 0
ORDER BY absolute_delay DESC;
```

**Merge progress**: active merges and their completion.

```sql
SELECT table, elapsed, round(progress * 100, 1) AS pct, rows_read, rows_written
FROM system.merges
ORDER BY elapsed DESC;
```

**Slow queries**: find what's hitting ClickHouse hardest.

```sql
SELECT
    user, query_kind,
    round(elapsed, 2) AS seconds,
    formatReadableSize(read_bytes) AS read,
    read_rows
FROM system.processes
ORDER BY elapsed DESC;
```

**Disk usage by partition**: useful for planning TTL and archival.

```sql
SELECT
    partition,
    formatReadableSize(sum(bytes_on_disk)) AS size,
    sum(rows) AS rows
FROM system.parts
WHERE active AND table = 'events'
GROUP BY partition
ORDER BY partition;
```

## Key Takeaways

- **Materialized views** fire on insert and maintain continuously updated targets — the primary pre-aggregation tool
- Use `AggregatingMergeTree` + `uniqState`/`uniqMerge` for non-additive metrics; `SummingMergeTree` for sums and counts
- Chain MVs for multi-level rollups; backfill with explicit `INSERT INTO ... SELECT`
- `ReplicatedMergeTree` synchronizes replicas via ZooKeeper/Keeper — production tables should always be replicated
- `Distributed` tables route queries across shards; the sharding key controls data locality
- Monitor part count, replication lag, and merge progress as primary cluster health signals

---

That wraps the ClickHouse Series. You now have the foundation to design, ingest, query, and operate ClickHouse at production scale: from choosing the right engine, through schema decisions that determine query speed before any query runs, to pre-aggregating with materialized views and managing a replicated, sharded cluster.
