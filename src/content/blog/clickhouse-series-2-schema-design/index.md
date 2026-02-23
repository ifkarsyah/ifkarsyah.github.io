---
title: "ClickHouse Series, Part 2: Schema Design"
description: "Choosing the right data types, ORDER BY key, partitioning strategy, and TTL — the decisions that determine query performance before a single query runs."
pubDate: 2024-06-16
author: "ifkarsyah"
domain: "Database"
stack: ["ClickHouse"]
image:
  src: ./clickhouse-series.png
  alt: "ClickHouse Schema Design"
---

## Schema as Performance

In Postgres, you can largely correct a bad schema with indexes. In ClickHouse, your schema IS your index. The `ORDER BY` key determines which queries are fast and which are slow. The partition key determines which parts of the table are scanned. Choosing these correctly upfront is the most impactful performance decision you will make.

## Data Types

### Integers

Use the smallest integer type that fits your range — smaller types compress better and scan faster:

```sql
user_id     UInt64,   -- unsigned 64-bit, max ~18 quintillion
event_count UInt32,   -- unsigned 32-bit, max ~4 billion
age         UInt8,    -- unsigned 8-bit, max 255
delta       Int32,    -- signed 32-bit when negatives are possible
```

Avoid `Int64` where `Int32` or `UInt32` suffices. The difference in compression and scan speed is meaningful at scale.

### Strings and LowCardinality

`String` stores arbitrary-length byte sequences. For columns with bounded cardinality (fewer than ~10,000 unique values), `LowCardinality(String)` stores values as a dictionary:

```sql
-- Bad: String for low-cardinality columns
country    String,
event_type String,

-- Good: LowCardinality compresses ~2-4x better
country    LowCardinality(String),
event_type LowCardinality(String),
```

`LowCardinality` is almost always the right choice for: country, city, device type, OS, browser, status, category. Use plain `String` for: user IDs stored as strings, URLs, free-text fields.

### DateTime and Date

Always prefer `DateTime` (seconds precision) or `DateTime64` (sub-second precision) over storing timestamps as strings or Unix epoch integers:

```sql
-- Bad
timestamp_str String,
timestamp_ms  UInt64,

-- Good
event_at  DateTime,          -- second precision, 4 bytes
event_at  DateTime64(3),     -- millisecond precision, 8 bytes
```

Use `Date` (2 bytes) for date-only columns like `report_date`, `signup_date`. It compresses better than `DateTime` and makes date arithmetic natural.

### Nullable

Avoid `Nullable` unless nulls are semantically meaningful. `Nullable(T)` adds a bitmask column and prevents many optimizations:

```sql
-- Avoid unless you actually need to distinguish NULL from 0/empty
views Nullable(UInt64)

-- Prefer a sentinel value
views UInt64 DEFAULT 0
```

`Nullable` is appropriate for optional join columns or fields that genuinely have no value (vs. "not measured").

### FixedString

For fixed-length strings like UUIDs or hashes, `FixedString(N)` is more compact than `String`:

```sql
session_id FixedString(36),  -- UUID stored as fixed 36 bytes
```

## ORDER BY Key

The `ORDER BY` key is the most important schema decision. ClickHouse stores data sorted by this key within each part, and uses it to skip granules (data blocks) during scans.

**Rule 1: Put columns you filter on in the ORDER BY key.**

```sql
-- If your queries always filter on event_type and user_id:
ORDER BY (event_type, user_id, date)

-- ClickHouse can skip entire blocks where event_type != 'click'
```

**Rule 2: Put low-cardinality columns first.**

Low-cardinality first means long runs of the same value, which compresses better and allows skipping more granules.

```sql
-- Good: low cardinality → high cardinality → time
ORDER BY (country, event_type, user_id, timestamp)

-- Less good: high cardinality first
ORDER BY (user_id, country, event_type, timestamp)
```

**Rule 3: The ORDER BY key is the primary key.**

`PRIMARY KEY` in ClickHouse defaults to the `ORDER BY` columns. You can specify a shorter prefix as the explicit `PRIMARY KEY` to build a sparser index while maintaining a richer sort order:

```sql
ORDER BY (event_type, user_id, date)
PRIMARY KEY (event_type, user_id)  -- index on first two columns only
```

## Partitioning

Partitioning divides a table into independent sub-tables (partitions). ClickHouse can skip entire partitions when a query's `WHERE` clause references the partition key.

```sql
-- Partition by month (most common for time-series)
PARTITION BY toYYYYMM(date)

-- Partition by day (for high-volume, short-retention data)
PARTITION BY toDate(timestamp)

-- Partition by a low-cardinality column
PARTITION BY country
```

**Don't over-partition.** Each partition creates separate parts on disk. Thousands of partitions slow down merges and metadata operations. A good rule: aim for no more than a few hundred active partitions. Monthly partitioning (`toYYYYMM`) is the safe default for most time-series data.

Partitions enable cheap **data management**:

```sql
-- Drop all data older than 3 months (instant — just deletes partition directory)
ALTER TABLE events DROP PARTITION '202401';

-- Detach a partition for archiving
ALTER TABLE events DETACH PARTITION '202312';
```

## TTL (Time To Live)

TTL automatically expires rows or moves them after a defined duration:

```sql
CREATE TABLE events (
    date     Date,
    user_id  UInt64,
    payload  String,
    TTL date + INTERVAL 90 DAY  -- delete rows older than 90 days
) ENGINE = MergeTree()
ORDER BY (user_id, date);
```

You can also use TTL to **move cold data to cheaper storage** (tiered storage):

```sql
TTL date + INTERVAL 30 DAY TO DISK 'cold_disk',
    date + INTERVAL 90 DAY DELETE
```

TTL is evaluated during merges and by a background process. Force immediate TTL cleanup:

```sql
ALTER TABLE events MATERIALIZE TTL;
```

## Putting It Together

A well-designed events table:

```sql
CREATE TABLE events (
    date        Date,
    timestamp   DateTime64(3),
    user_id     UInt64,
    session_id  FixedString(36),
    event_type  LowCardinality(String),
    country     LowCardinality(String),
    os          LowCardinality(String),
    properties  String,
    TTL date + INTERVAL 180 DAY
) ENGINE = MergeTree()
PARTITION BY toYYYYMM(date)
ORDER BY (event_type, country, user_id, timestamp)
SETTINGS index_granularity = 8192;
```

- `LowCardinality` on all bounded-cardinality strings
- `DateTime64(3)` for millisecond event timestamps
- `Date` for the partition key (cheaper than `DateTime` for range pruning)
- `ORDER BY` starts with low-cardinality filter columns
- Monthly partitioning for easy old-data management
- TTL for automatic retention enforcement

## Key Takeaways

- `LowCardinality(String)` is free performance for any column with fewer than ~10k unique values
- Avoid `Nullable` unless nulls are semantically meaningful
- The `ORDER BY` key is your primary performance lever — put low-cardinality filter columns first
- Partition by time (`toYYYYMM`) for easy data lifecycle management; avoid over-partitioning
- Use `TTL` to automate data expiration and tiered storage migration

Next: Data Ingestion — getting data into ClickHouse efficiently at scale.
