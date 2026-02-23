---
title: "ClickHouse Series, Part 5: Query Optimization"
description: "Making ClickHouse queries faster — profiling with system.query_log, projections, query patterns, and what actually moves the needle."
pubDate: 2024-07-07
author: "ifkarsyah"
domain: "Database"
stack: ["ClickHouse"]
image:
  src: ./clickhouse-series.png
  alt: "ClickHouse Query Optimization"
---

## Measure Before You Optimize

The most common mistake in query optimization is guessing. ClickHouse gives you excellent observability — use it before changing anything.

```sql
-- Find your slowest queries in the past 24 hours
SELECT
    normalizeQuery(query) AS query_pattern,
    count()               AS executions,
    avg(elapsed)          AS avg_seconds,
    avg(read_rows)        AS avg_rows_read,
    formatReadableSize(avg(read_bytes)) AS avg_data_read
FROM system.query_log
WHERE type = 'QueryFinish'
  AND event_time > now() - INTERVAL 24 HOUR
GROUP BY query_pattern
ORDER BY avg_seconds DESC
LIMIT 20;
```

`read_rows` is the key signal. If a query reads 500 million rows to return 10 rows, your sort order, partitioning, or indexes are not helping for that query shape.

For a specific query, use `EXPLAIN`:

```sql
-- See which parts and granules are scanned
EXPLAIN indexes = 1
SELECT count() FROM events WHERE event_type = 'click' AND date = '2024-01-01';
```

The output shows `Selected parts` and `Selected granules` vs total — if selected/total is close to 1.0, the query is scanning most of the table.

## ORDER BY Alignment

The most impactful optimization is almost always aligning your `WHERE` clause with the `ORDER BY` key. Covered thoroughly in Part 2, but the practical test:

```sql
-- Table: ORDER BY (event_type, user_id, date)

-- FAST: filters on prefix of ORDER BY key
SELECT count() FROM events WHERE event_type = 'click';

-- FAST: filters on full prefix
SELECT count() FROM events WHERE event_type = 'click' AND user_id = 42;

-- SLOW: skips the first ORDER BY column
SELECT count() FROM events WHERE user_id = 42;
-- user_id is the second column — ClickHouse cannot use the index without event_type
```

If a critical query filters on a column not at the start of the ORDER BY key, consider a **projection** (below) or restructuring the ORDER BY.

## Projections

A **projection** is an alternative sort order (or pre-aggregation) stored within the same table. When a query matches the projection's ORDER BY, ClickHouse uses the projection's data instead of the main table — without the user needing to know it exists.

```sql
-- Main table: ORDER BY (event_type, user_id, date)
-- Add a projection optimized for user-centric queries
ALTER TABLE events ADD PROJECTION proj_by_user (
    SELECT * ORDER BY (user_id, date)
);

-- Materialize the projection on existing data
ALTER TABLE events MATERIALIZE PROJECTION proj_by_user;
```

Now `SELECT * FROM events WHERE user_id = 42` automatically uses `proj_by_user` — fast granule skipping on `user_id` without changing the table's primary ORDER BY.

Projections can also pre-aggregate:

```sql
ALTER TABLE events ADD PROJECTION proj_daily_counts (
    SELECT
        toDate(timestamp) AS date,
        event_type,
        country,
        count()       AS event_count,
        uniq(user_id) AS dau
    ORDER BY (date, event_type, country)
);
```

Queries like `SELECT date, count() FROM events GROUP BY date` automatically hit this projection, returning in milliseconds regardless of the raw table size.

**Storage cost**: projections double (or more) the disk usage for the table. Use them selectively for high-frequency query shapes.

## Query Patterns

### Use toDate / toStartOfHour for time bucketing

```sql
-- Bad: function on raw timestamp prevents partition pruning
SELECT date_trunc('day', timestamp), count()
FROM events GROUP BY 1;

-- Good: ClickHouse-native functions that work with partitions
SELECT toDate(timestamp), count()
FROM events GROUP BY 1;
```

### Filter before JOIN, not after

ClickHouse joins load the right-hand table into memory. Filter it down before the join:

```sql
-- Bad: join first, filter after
SELECT e.*, u.country
FROM events e JOIN users u ON e.user_id = u.user_id
WHERE u.country = 'US';

-- Good: filter the right table before joining
SELECT e.*, u.country
FROM events e
JOIN (SELECT user_id, country FROM users WHERE country = 'US') u
  ON e.user_id = u.user_id;
```

### Prefer uniq() over count(distinct)

`uniq()` uses HyperLogLog approximation — much faster and uses constant memory. For exact counts, use `uniqExact()` (slower but precise):

```sql
-- Approximate (±2% error, much faster)
SELECT uniq(user_id) FROM events WHERE date = today();

-- Exact (slower, higher memory)
SELECT uniqExact(user_id) FROM events WHERE date = today();
```

### Use quantile() instead of ORDER BY + LIMIT for percentiles

```sql
-- Bad: sorts entire result set
SELECT elapsed FROM queries ORDER BY elapsed DESC LIMIT 1;

-- Good: single-pass quantile computation
SELECT quantile(0.99)(elapsed) FROM queries;

-- Multiple percentiles in one pass
SELECT quantilesTDigest(0.5, 0.9, 0.95, 0.99)(elapsed) FROM queries;
```

### PREWHERE for heavy filters

`PREWHERE` applies a filter before reading all columns — cheaper when the filter eliminates many rows:

```sql
SELECT user_id, properties
FROM events
PREWHERE event_type = 'click'   -- applied first, on just this column
WHERE date >= '2024-01-01';
```

ClickHouse applies `PREWHERE` automatically for simple conditions. Explicit `PREWHERE` is useful for complex conditions you know are highly selective.

## Sampling

For exploratory queries on huge tables, use `SAMPLE` to work on a fraction of the data:

```sql
-- Query 1% of the data (fast, approximate)
SELECT count() FROM events SAMPLE 0.01;

-- Deterministic sample (same rows each time for a given key)
SELECT uniq(user_id) FROM events SAMPLE 1/100;
```

Sampling works at the granule level — ClickHouse reads every 100th granule. Results are approximate but proportionally accurate for aggregations.

## Further Reading

The standalone post [ClickHouse Query Optimization: What Actually Moves the Needle](/blog/clickhouse-query-optimization) covers ORDER BY key selection, `LowCardinality`, materialized views for hot aggregations, and profiling in more depth with real-world examples from a production product analytics platform.

## Key Takeaways

- Profile with `system.query_log` — look at `read_rows` to see how much the table is actually being scanned
- Align `WHERE` clauses with the `ORDER BY` prefix for granule skipping
- Use **projections** to add alternative sort orders or pre-aggregations without changing the table schema
- Prefer `uniq()` over `count(distinct)`, `quantile()` over `ORDER BY + LIMIT`, and `PREWHERE` for selective filters
- Use `SAMPLE` for exploratory queries on large tables — fast and approximately correct

Next: Materialized Views & Operations — pre-aggregation patterns, replication, sharding, and keeping ClickHouse healthy.
