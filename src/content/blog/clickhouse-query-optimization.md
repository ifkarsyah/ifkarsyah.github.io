---
title: "ClickHouse Query Optimization: What Actually Moves the Needle"
description: "Practical techniques for speeding up analytical queries in ClickHouse — from table design to materialized views and query profiling."
pubDate: 2024-01-10
author: "ifkarsyah"
tags: ["ClickHouse", "SQL", "Data Platform"]
image:
  url: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=800"
  alt: "Server infrastructure"
---

## Introduction

ClickHouse can query billions of rows in milliseconds — but only if your schema and queries work with its storage model, not against it. After running ClickHouse in production for a product analytics platform, here are the optimizations that had the biggest real-world impact.

## 1. ORDER BY is Everything

ClickHouse stores data sorted by the `ORDER BY` key. Queries that filter or group on those columns skip entire data granules (chunks of ~8192 rows) without reading them.

```sql
-- Bad: ORDER BY (date) alone — user_id scans are expensive
-- Good: ORDER BY (event_type, user_id, date) — common filters align with sort order
CREATE TABLE events (
    date       Date,
    user_id    UInt64,
    event_type LowCardinality(String)
) ENGINE = MergeTree()
ORDER BY (event_type, user_id, date);
```

Rule of thumb: put low-cardinality columns first in `ORDER BY`, high-cardinality last.

## 2. Use LowCardinality for String Columns

`LowCardinality(String)` stores values as a dictionary, typically 2-4x compression improvement for columns with fewer than 10,000 unique values.

```sql
-- Instead of:
event_type String

-- Use:
event_type LowCardinality(String)
```

This is free performance — add it to any string column with bounded cardinality.

## 3. Materialized Views for Hot Aggregations

If your dashboards always query the same aggregation (e.g., daily active users per country), pre-compute it with a materialized view:

```sql
CREATE MATERIALIZED VIEW dau_by_country
ENGINE = SummingMergeTree()
ORDER BY (date, country)
AS SELECT
    toDate(timestamp) AS date,
    country,
    uniq(user_id)     AS dau
FROM events
GROUP BY date, country;
```

Queries against `dau_by_country` return in milliseconds regardless of raw event volume.

## 4. Profile with system.query_log

Before optimizing anything, measure:

```sql
SELECT
    query,
    read_rows,
    read_bytes,
    elapsed
FROM system.query_log
WHERE type = 'QueryFinish'
  AND query LIKE '%events%'
ORDER BY elapsed DESC
LIMIT 10;
```

`read_rows` tells you how much data ClickHouse actually scanned. If it's close to your total row count, your `ORDER BY` isn't helping for that query shape.

## Conclusion

Most ClickHouse performance issues come down to three things: a poorly chosen `ORDER BY` key, missing `LowCardinality` annotations, and lacking materialized views for hot query patterns. Fix those first before reaching for more complex solutions.
