---
title: "Iceberg Series, Part 4: Hidden Partitioning & Evolution"
description: "Partition transforms that derive partition values automatically, partition evolution that changes strategy without rewriting data, and why these are Iceberg's biggest ergonomic wins."
pubDate: 2024-11-03
author: "ifkarsyah"
domain: "Data Lake"
stack: ["Apache Iceberg"]
image:
  src: ./iceberg-series.png
  alt: "Apache Iceberg Hidden Partitioning and Evolution"
---

## The Problem with Explicit Partitioning

In Hive-style partitioning (used by Delta Lake and plain Parquet), you add a separate column for the partition value:

```sql
-- Hive/Delta style: explicit partition column
CREATE TABLE events (
    event_at   TIMESTAMP,
    user_id    BIGINT,
    event_type STRING,
    date       DATE    -- separate column just for partitioning
) PARTITIONED BY (date);
```

This creates several problems:

1. **Redundant columns**: `date` is derived from `event_at` — you store the same information twice
2. **Query correctness burden**: queries must filter on `date`, not `event_at`, to get partition pruning. Filtering on `event_at` without `date` scans everything
3. **Partition evolution pain**: if you want to switch from daily to hourly partitioning, you must rewrite the entire table — or maintain two separate tables
4. **Wrong types in data**: partition values are stored as strings in Hive-style directories (`date=2024-01-01`)

Iceberg eliminates all of these with **hidden partitioning**.

## Hidden Partitioning

In Iceberg, partition values are **derived** from data columns using **transforms** — they are never stored in the data files themselves. The engine computes the partition value automatically at write time and uses it for pruning at read time, transparently.

```sql
-- Iceberg style: partition by days(event_at)
CREATE TABLE local.db.events (
    event_at   TIMESTAMP,
    user_id    BIGINT,
    event_type STRING
) USING iceberg
PARTITIONED BY (days(event_at));
```

No `date` column. No `event_at_date` column. The table has three columns. Iceberg derives `days(event_at)` internally for partitioning.

A query `WHERE event_at BETWEEN '2024-01-01' AND '2024-01-03'` automatically prunes to the relevant day partitions — **the user writes natural predicates on the actual column**, not the derived partition column.

## Partition Transforms

Iceberg supports the following built-in transforms:

### Identity

No transformation — use the column value directly as the partition value:

```sql
PARTITIONED BY (identity(country))
-- or shorthand:
PARTITIONED BY (country)
```

Use for low-cardinality categorical columns (country, region, status). Same as Hive-style partitioning but without the redundant column.

### Time-Based Transforms

```sql
PARTITIONED BY (years(event_at))     -- partition by year
PARTITIONED BY (months(event_at))    -- partition by year-month
PARTITIONED BY (days(event_at))      -- partition by date (most common)
PARTITIONED BY (hours(event_at))     -- partition by date-hour
```

All four work on `TIMESTAMP`, `TIMESTAMPTZ`, or `DATE` columns. Iceberg handles the extraction internally — your data column stays clean.

### Bucket

Hash the column value into N buckets. Distributes high-cardinality columns (user_id, order_id) evenly without creating millions of partitions:

```sql
-- Distribute user_id into 64 buckets
PARTITIONED BY (bucket(64, user_id))
```

Bucket partitioning is essential for joins: if two tables are both bucketed on the same key with the same bucket count, Spark can perform a **bucket join** without a shuffle — reading only the matching bucket from each table.

### Truncate

Truncate a string or integer to a prefix/range:

```sql
-- Partition by first 4 characters of a string (e.g., postal code prefix)
PARTITIONED BY (truncate(4, postal_code))

-- Partition integers by ranges of 1000 (0–999, 1000–1999, ...)
PARTITIONED BY (truncate(1000, user_id))
```

### Combining Transforms

```sql
-- Daily partitioning + country, both hidden
PARTITIONED BY (days(event_at), country)

-- Hourly + user bucket for high-throughput event tables
PARTITIONED BY (hours(event_at), bucket(32, user_id))
```

## Partition Pruning in Action

With `PARTITIONED BY (days(event_at), country)`:

```sql
-- Pruned to: day=2024-01-01, country=US — scans ~1/365 * 1/countries of the data
SELECT * FROM events
WHERE event_at >= '2024-01-01' AND event_at < '2024-01-02'
  AND country = 'US';

-- Pruned to all US partitions across all days
SELECT count(*) FROM events WHERE country = 'US';

-- NOT pruned on days — no day filter, scans all days (still pruned on country)
SELECT count(*) FROM events WHERE user_id = 42;
```

The key insight: **you filter on the real column (`event_at`, `country`), Iceberg figures out the partition pruning**. No need to know the internal partition representation.

## Partition Evolution

This is Iceberg's most powerful and unique feature. You can **change the partitioning strategy of a table without rewriting any data**.

Scenario: your events table was initially partitioned by month. Volume grew and you need daily partitioning for better query performance.

```sql
-- Current: monthly partitioning
-- Add daily partitioning going forward (old data keeps month partitions)
ALTER TABLE local.db.events
REPLACE PARTITION FIELD months(event_at) WITH days(event_at);
```

After this:
- **Old data** (before the ALTER) is still in monthly partitions — no rewrite
- **New data** (after the ALTER) goes into daily partitions
- **Queries** correctly prune both old monthly partitions and new daily partitions based on the predicate

```
events/
├── data/event_at_month=2023-11/   ← old monthly partitions
├── data/event_at_month=2023-12/   ← old monthly partitions
├── data/event_at_day=2024-01-01/  ← new daily partitions (after evolution)
├── data/event_at_day=2024-01-02/
└── ...
```

Iceberg tracks which partition spec applies to each data file in the manifest. The query planner consults the appropriate spec per file — old files use the month transform for pruning, new files use the day transform.

### Other Evolution Operations

```sql
-- Add a new partition field
ALTER TABLE local.db.events ADD PARTITION FIELD bucket(32, user_id);

-- Remove a partition field (new data becomes unpartitioned on that field)
ALTER TABLE local.db.events DROP PARTITION FIELD country;

-- Change bucket count (new files use new count; old files keep old count)
ALTER TABLE local.db.events
REPLACE PARTITION FIELD bucket(32, user_id) WITH bucket(64, user_id);
```

## Sort Order

Iceberg also tracks a **sort order** for data files — how rows should be sorted within each file. This enables fine-grained data skipping inside files, similar to ClickHouse's ORDER BY:

```sql
CREATE TABLE local.db.events (...)
USING iceberg
PARTITIONED BY (days(event_at))
TBLPROPERTIES ('write.sort-order' = 'user_id ASC NULLS LAST, event_at ASC');
```

Or set after creation:

```sql
ALTER TABLE local.db.events WRITE ORDERED BY user_id, event_at;
```

Sort order is advisory by default — engines respect it when writing but are not required to. In Spark, enable `write.distribution-mode = range` to enforce the sort order during writes.

## Why This Matters for Data Engineering

Hidden partitioning and partition evolution eliminate two of the most painful data engineering problems:

**"Which column do I filter on?"** — With Hive-style, analysts need to know to use `date` not `event_at`. With Iceberg, they filter on `event_at` naturally and partition pruning just works.

**"We need to repartition the table"** — With Hive-style, this means a full table rewrite, downtime, and coordinating schema changes across all consumers. With Iceberg, it is a one-line `ALTER TABLE`, takes effect immediately, and old data is untouched.

## Key Takeaways

- **Hidden partitioning** derives partition values from data columns using transforms — no extra columns, natural predicate syntax
- Transforms: `identity`, `years/months/days/hours`, `bucket(N, col)`, `truncate(N, col)`
- **Bucket** distributes high-cardinality keys evenly and enables bucket joins
- **Partition evolution** changes the partitioning strategy without rewriting data — old and new files coexist with different specs
- Iceberg tracks the sort order of data files, enabling fine-grained skipping inside files

Next: Row-Level Operations — how MERGE, UPDATE, and DELETE are implemented with copy-on-write and merge-on-read, and the performance trade-offs between them.
