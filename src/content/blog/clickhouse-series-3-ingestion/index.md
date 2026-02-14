---
title: "ClickHouse Series, Part 3: Data Ingestion"
description: "Getting data into ClickHouse efficiently — batch inserts, async inserts, the Kafka table engine, S3 integration, and ingestion best practices."
pubDate: 2024-06-23
author: "ifkarsyah"
tags: ["ClickHouse", "SQL", "Data Engineering"]
image:
  src: ./clickhouse-series.png
  alt: "ClickHouse Data Ingestion"
---

## How ClickHouse Receives Data

ClickHouse writes data in **parts**: each insert creates a new directory on disk containing sorted, compressed column files. Background **merges** consolidate many small parts into fewer large ones. This means insert performance depends heavily on how you batch data — too many small inserts create too many small parts, overwhelming the merge process.

The golden rule: **insert in large batches, not row by row.**

## Batch Inserts

The simplest pattern is to accumulate records in your application and flush in bulk:

```python
import clickhouse_connect

client = clickhouse_connect.get_client(host="clickhouse", port=8123)

batch = []
for event in event_stream:
    batch.append([
        event["date"],
        event["user_id"],
        event["event_type"],
        event["country"],
    ])
    if len(batch) >= 10_000:
        client.insert("events", batch, column_names=["date", "user_id", "event_type", "country"])
        batch.clear()
```

**Target batch size**: 10,000–100,000 rows per insert. Smaller batches create too many parts; larger batches add latency. For high-throughput pipelines, 100k rows every few seconds is typical.

**Never insert one row at a time.** A single-row insert creates a part. 10,000 single-row inserts create 10,000 parts. ClickHouse will eventually refuse inserts with `Too many parts` errors.

## Async Insert Mode

If your application cannot easily batch (e.g., event-driven microservices sending one event per request), use **async inserts**. ClickHouse buffers small inserts in memory and flushes them as a single large insert:

```sql
-- Enable globally on server
SET async_insert = 1;
SET wait_for_async_insert = 0;     -- fire and forget (higher throughput)
SET async_insert_max_data_size = 10485760;  -- flush when buffer reaches 10 MB
SET async_insert_busy_timeout_ms = 1000;   -- or every 1 second
```

Or per-query:
```python
client.insert(
    "events",
    data,
    settings={"async_insert": 1, "wait_for_async_insert": 0}
)
```

With `wait_for_async_insert=0`, the client gets an immediate acknowledgment and ClickHouse inserts asynchronously. With `wait_for_async_insert=1`, the client waits until the buffer flushes — giving durability at the cost of latency.

Async inserts are ideal for: high-frequency small inserts from many microservices, edge/IoT telemetry, application event tracking SDKs.

## Kafka Table Engine

ClickHouse has a native **Kafka table engine** that reads directly from Kafka topics. The pattern uses three objects:

1. A **Kafka engine table** — reads from Kafka (does not store data)
2. A **MergeTree destination table** — stores data permanently
3. A **materialized view** — continuously moves data from the Kafka table to the destination

```sql
-- 1. Kafka source table (reads from Kafka, stateless)
CREATE TABLE events_kafka (
    timestamp  DateTime64(3),
    user_id    UInt64,
    event_type LowCardinality(String),
    country    LowCardinality(String)
) ENGINE = Kafka
SETTINGS
    kafka_broker_list     = 'kafka:9092',
    kafka_topic_list      = 'user-events',
    kafka_group_name      = 'clickhouse-consumer',
    kafka_format          = 'JSONEachRow',
    kafka_num_consumers   = 4;

-- 2. Destination table (stores data)
CREATE TABLE events (
    timestamp  DateTime64(3),
    user_id    UInt64,
    event_type LowCardinality(String),
    country    LowCardinality(String)
) ENGINE = MergeTree()
PARTITION BY toDate(timestamp)
ORDER BY (event_type, user_id, timestamp);

-- 3. Materialized view wires them together
CREATE MATERIALIZED VIEW events_mv TO events AS
SELECT * FROM events_kafka;
```

The materialized view triggers on every Kafka poll. ClickHouse tracks offsets in Kafka consumer groups — if the server restarts, it resumes from the last committed offset.

Supported formats: `JSONEachRow`, `Avro`, `Protobuf`, `CSV`, and more.

## S3 Integration

ClickHouse can read from and write to S3 directly using the `s3()` table function:

```sql
-- Read from S3
SELECT *
FROM s3(
    's3://my-bucket/events/2024-01/*.parquet',
    'ACCESS_KEY', 'SECRET_KEY',
    'Parquet'
)
WHERE event_type = 'click';

-- Insert from S3 into a table
INSERT INTO events
SELECT *
FROM s3('s3://my-bucket/events/2024-01/*.parquet', 'Parquet');
```

For a **permanent S3-backed table** (data lives in S3, not local disk):

```sql
CREATE TABLE events_s3 (
    timestamp  DateTime64(3),
    user_id    UInt64,
    event_type String
) ENGINE = S3('s3://my-bucket/events/*.parquet', 'ACCESS_KEY', 'SECRET_KEY', 'Parquet');
```

S3-backed tables are useful for cold archival data or cross-tool sharing (the same Parquet files can be read by Spark, Athena, and ClickHouse). For hot query paths, insert into a local MergeTree table for best performance.

## Bulk Loading with clickhouse-client

For one-time bulk loads, `clickhouse-client` with piped input is the fastest option:

```bash
# Load from CSV
clickhouse-client \
  --query "INSERT INTO events FORMAT CSVWithNames" \
  < events.csv

# Load from Parquet
clickhouse-client \
  --query "INSERT INTO events FORMAT Parquet" \
  < events.parquet

# Load from a remote HTTP source
curl -s https://data.example.com/events.csv.gz \
  | gunzip \
  | clickhouse-client --query "INSERT INTO events FORMAT CSVWithNames"
```

## Ingestion Best Practices

**Batch size**: 10k–100k rows per insert is the sweet spot. Monitor `system.parts` — if the part count is growing faster than merges can keep up, your inserts are too small or too frequent.

```sql
-- Check current part counts per table
SELECT table, count() AS parts, sum(rows) AS total_rows
FROM system.parts
WHERE active AND database = 'default'
GROUP BY table
ORDER BY parts DESC;
```

**Insert format**: `RowBinary` is the fastest binary format for programmatic inserts. `JSONEachRow` is convenient but slower due to parsing overhead.

**Avoid frequent schema changes during high-load ingestion** — `ALTER TABLE ADD COLUMN` requires touching all parts and can spike I/O.

**Deduplicate at the source** when possible. If you must handle duplicates, use `ReplacingMergeTree` (covered in Part 1) or ClickHouse's insert deduplication:

```sql
-- ClickHouse deduplicates inserts with the same data block hash
-- (automatic, on by default for Replicated tables)
SET insert_deduplicate = 1;
```

## Key Takeaways

- **Insert in large batches** (10k–100k rows): row-by-row inserts create too many parts and break merges
- **Async inserts** let ClickHouse buffer small inserts server-side — useful for event-driven services
- The **Kafka engine + materialized view** pattern provides continuous streaming ingestion with offset tracking
- **S3 integration** supports ad-hoc queries on object storage and bulk historical loads
- Monitor `system.parts` to detect when insert rate is outpacing the merge process

Next: Internals — how ClickHouse actually stores data as parts, runs background merges, and builds indexes.
