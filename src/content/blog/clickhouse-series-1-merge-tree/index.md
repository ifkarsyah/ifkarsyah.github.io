---
title: "ClickHouse Series, Part 1: MergeTree Engines"
description: "The storage engine family at the heart of ClickHouse — MergeTree and its specialized variants for deduplication, aggregation, and updates."
pubDate: 2024-06-09
author: "ifkarsyah"
domain: "Analytics"
stack: ["ClickHouse"]
image:
  src: ./clickhouse-series.png
  alt: "ClickHouse MergeTree Engines"
---

## Why Engines Matter

In ClickHouse, every table has an **engine** that defines how data is stored, merged, and queried. Unlike Postgres where the storage engine is invisible, ClickHouse exposes it explicitly — and the right choice dramatically affects both correctness and performance.

The **MergeTree** family is the foundation of nearly every production ClickHouse table. Each variant adds a specific behavior on top of the base engine.

## MergeTree (Base)

The base engine: append data in sorted order, run background merges to consolidate parts.

```sql
CREATE TABLE events (
    date        Date,
    user_id     UInt64,
    event_type  LowCardinality(String),
    properties  String
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (event_type, user_id, date);
```

Use `MergeTree` when:
- You are inserting immutable events (logs, analytics events, time-series)
- You do not need deduplication, automatic aggregation, or row updates

`MergeTree` is the default choice. Reach for a specialized variant only when you have a specific need.

## ReplacingMergeTree

Deduplicates rows with the same `ORDER BY` key, keeping only the latest version. Deduplication happens **during background merges**, not at insert time — so duplicates may be visible between merges.

```sql
CREATE TABLE user_profiles (
    user_id     UInt64,
    name        String,
    email       String,
    updated_at  DateTime
) ENGINE = ReplacingMergeTree(updated_at)
ORDER BY user_id;
```

The `updated_at` column is the version: among rows with the same `user_id`, the one with the highest `updated_at` survives.

**Gotcha**: because merges are asynchronous, a query can still see duplicates. Use `FINAL` to force deduplication at query time (slower):

```sql
SELECT * FROM user_profiles FINAL WHERE user_id = 42;
```

Use `ReplacingMergeTree` for: user profile tables, entity state tables, any table where you want upsert semantics.

## SummingMergeTree

Automatically sums numeric columns for rows with the same `ORDER BY` key during merges.

```sql
CREATE TABLE daily_revenue (
    date        Date,
    country     LowCardinality(String),
    revenue     Decimal(18, 2),
    order_count UInt64
) ENGINE = SummingMergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (date, country);
```

When ClickHouse merges parts, rows with the same `(date, country)` are collapsed into one row with summed `revenue` and `order_count`. Inserting incremental updates is safe — they will eventually be merged into the running total.

**Gotcha**: like `ReplacingMergeTree`, merges are async. Always use `sum()` in your queries to handle the case where parts haven't merged yet:

```sql
SELECT date, country, sum(revenue), sum(order_count)
FROM daily_revenue
GROUP BY date, country;
```

Use `SummingMergeTree` for: pre-aggregated counters, running totals, metrics rollups.

## AggregatingMergeTree

The general-purpose aggregation engine. Stores intermediate aggregation states (not final values), which are merged correctly even across multiple merge rounds.

```sql
CREATE TABLE dau_by_country (
    date        Date,
    country     LowCardinality(String),
    dau         AggregateFunction(uniq, UInt64)
) ENGINE = AggregatingMergeTree()
ORDER BY (date, country);
```

`AggregateFunction(uniq, UInt64)` stores the HyperLogLog state for `uniq`, not a final count. This means distinct counts are correct even after multiple merges.

This engine is almost always used with **materialized views** (covered in Part 6). You rarely insert into it directly.

```sql
-- Insert using State combiners
INSERT INTO dau_by_country
SELECT
    toDate(timestamp) AS date,
    country,
    uniqState(user_id) AS dau
FROM events
GROUP BY date, country;

-- Query using Merge combiners
SELECT date, country, uniqMerge(dau) AS dau
FROM dau_by_country
GROUP BY date, country;
```

Use `AggregatingMergeTree` for: accurate pre-aggregations of non-additive metrics (distinct counts, quantiles, top-k).

## CollapsingMergeTree

Handles row deletion by inserting a "cancel" row with `sign = -1`. During merges, rows with `sign = 1` and `sign = -1` for the same key cancel each other out.

```sql
CREATE TABLE order_states (
    order_id    UInt64,
    status      String,
    amount      Decimal(18, 2),
    sign        Int8
) ENGINE = CollapsingMergeTree(sign)
ORDER BY order_id;

-- Insert original row
INSERT INTO order_states VALUES (1, 'pending', 100.00, 1);

-- Update: cancel the old row, insert new
INSERT INTO order_states VALUES (1, 'pending', 100.00, -1);
INSERT INTO order_states VALUES (1, 'shipped', 100.00,  1);
```

`VersionedCollapsingMergeTree` adds a version column for out-of-order inserts — the safer choice when update events may arrive out of order.

Use `CollapsingMergeTree` for: mutable row patterns where you control the insert stream (e.g., CDC pipelines, order state machines).

## Engine Selection Summary

| Need | Engine |
|------|--------|
| Immutable events, logs | `MergeTree` |
| Upserts / last-write-wins | `ReplacingMergeTree` |
| Running sums and counts | `SummingMergeTree` |
| Non-additive aggregations (distinct, quantile) | `AggregatingMergeTree` |
| Mutable rows with deletes | `CollapsingMergeTree` |
| Replication | Prefix any of the above with `Replicated` |

For replication, every MergeTree variant has a `Replicated` counterpart:
```sql
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/events', '{replica}')
```

The ZooKeeper/Keeper path and replica name are the only additions — the rest of the engine behavior is identical.

## Key Takeaways

- `MergeTree` is the base — use it for immutable append-only data
- `ReplacingMergeTree` deduplicates on `ORDER BY` key; use `FINAL` or `sum()` to handle pre-merge visibility
- `SummingMergeTree` collapses rows into running sums; always aggregate at query time
- `AggregatingMergeTree` stores intermediate aggregation states for correct merging of non-additive metrics
- `CollapsingMergeTree` enables updates and deletes via signed rows
- All engines have a `Replicated` variant for HA deployments

Next: Schema Design — choosing the right data types, ORDER BY key, partitioning strategy, and TTL.
