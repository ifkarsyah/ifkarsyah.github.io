---
title: "Delta Lake Series, Part 6: Streaming & CDC"
description: "Writing to Delta with Structured Streaming, exactly-once guarantees, reading Delta as a stream, and Change Data Feed for downstream propagation."
pubDate: 2024-09-15
author: "ifkarsyah"
tags: ["Delta Lake", "Data Engineering", "Data Lake"]
image:
  src: ./delta-lake-series.png
  alt: "Delta Lake Streaming and CDC"
---

## Delta Lake as a Streaming Sink and Source

One of Delta Lake's most powerful properties is that the same table works for both batch and streaming workloads. A dashboard batch job and a Kafka-consuming stream processor can read and write the same Delta table concurrently — with full ACID guarantees.

Delta Lake integrates natively with Spark's **Structured Streaming** API. You can write a stream to Delta and read a Delta table as a stream, treating each new commit as a micro-batch of changes.

## Writing a Stream to Delta

```python
from pyspark.sql import SparkSession
from pyspark.sql.functions import from_json, col
from pyspark.sql.types import StructType, StringType, LongType, TimestampType

spark = SparkSession.builder.appName("streaming-to-delta").getOrCreate()

# Define schema of incoming Kafka events
schema = StructType() \
    .add("user_id", LongType()) \
    .add("event_type", StringType()) \
    .add("country", StringType()) \
    .add("timestamp", TimestampType())

# Read from Kafka
kafka_stream = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "kafka:9092") \
    .option("subscribe", "user-events") \
    .load()

events = kafka_stream \
    .select(from_json(col("value").cast("string"), schema).alias("data")) \
    .select("data.*")

# Write to Delta
query = events.writeStream \
    .format("delta") \
    .outputMode("append") \
    .option("checkpointLocation", "s3://my-bucket/checkpoints/events") \
    .trigger(processingTime="30 seconds") \
    .start("s3://my-bucket/tables/events")

query.awaitTermination()
```

The **checkpoint location** is critical: Structured Streaming stores its progress (Kafka offsets and Delta commit versions) in this directory. On restart, the stream resumes exactly from where it left off.

## Exactly-Once Writes

Delta Lake + Structured Streaming provides **end-to-end exactly-once** guarantees, even across failures:

1. Structured Streaming tracks the Kafka offset of each micro-batch in the checkpoint
2. Delta Lake writes each micro-batch as an atomic commit
3. If the job fails mid-write, the partial Parquet files are not referenced in the transaction log — they are invisible
4. On restart, the stream re-reads from the last committed Kafka offset and re-writes the micro-batch as a new Delta commit

Delta Lake uses **idempotent writes** to handle the case where a micro-batch was written to Parquet but the Delta commit failed: it checks whether the transaction ID already exists in the log and skips the write if so.

Enable idempotent writes explicitly:

```python
query = events.writeStream \
    .format("delta") \
    .option("checkpointLocation", "s3://...") \
    .option("txnAppId", "kafka-to-delta-events") \
    .option("txnVersion", "1") \
    .start("s3://my-bucket/tables/events")
```

## Merge Streaming (Upsert Stream)

For streaming CDC — where events represent inserts, updates, and deletes — use `foreachBatch` to apply a `MERGE` on each micro-batch:

```python
from delta.tables import DeltaTable

def upsert_to_delta(micro_batch_df, batch_id):
    target = DeltaTable.forPath(spark, "s3://my-bucket/tables/users")

    target.alias("t").merge(
        micro_batch_df.alias("s"),
        "t.user_id = s.user_id"
    ).whenMatchedUpdateAll() \
     .whenNotMatchedInsertAll() \
     .whenNotMatchedBySourceDelete() \   # delete rows not in source
     .execute()

query = cdc_stream.writeStream \
    .foreachBatch(upsert_to_delta) \
    .option("checkpointLocation", "s3://my-bucket/checkpoints/users") \
    .trigger(processingTime="1 minute") \
    .start()
```

`foreachBatch` passes each micro-batch as a regular DataFrame to your function. This gives full control over the write logic while preserving exactly-once semantics through the checkpoint.

## Reading Delta as a Stream

A Delta table is itself a valid streaming source. Each new commit to the table is treated as a micro-batch:

```python
# Read new rows as they are appended to the Delta table
stream = spark.readStream \
    .format("delta") \
    .load("s3://my-bucket/tables/events")

# Process and write downstream
stream.writeStream \
    .format("delta") \
    .option("checkpointLocation", "s3://my-bucket/checkpoints/enriched") \
    .start("s3://my-bucket/tables/enriched-events")
```

This enables **Delta-to-Delta pipelines**: a chain of streaming jobs where each stage reads from an upstream Delta table and writes to a downstream one. Every stage is independently restartable from its checkpoint.

Control how much history to start from:

```python
spark.readStream \
    .format("delta") \
    .option("startingVersion", 10) \    # start from version 10
    .load("s3://my-bucket/tables/events")

spark.readStream \
    .format("delta") \
    .option("startingTimestamp", "2024-01-01") \  # start from this timestamp
    .load("s3://my-bucket/tables/events")
```

## Change Data Feed (CDF) Streaming

The standard Delta stream source emits all rows in new commits (both inserts and rewrites from UPDATE/MERGE). **Change Data Feed** is more precise: it emits only the actual changed rows with their change type (`insert`, `update_preimage`, `update_postimage`, `delete`).

Enable CDF on the source table:

```sql
ALTER TABLE events SET TBLPROPERTIES (delta.enableChangeDataFeed = true);
```

Read it as a stream:

```python
cdf_stream = spark.readStream \
    .format("delta") \
    .option("readChangeData", "true") \
    .option("startingVersion", 0) \
    .load("s3://my-bucket/tables/events")

# Each row includes: _change_type, _commit_version, _commit_timestamp
cdf_stream.select("_change_type", "user_id", "country", "_commit_version").show()
```

CDF is the foundation for:
- **Propagating changes downstream**: replicate only changed rows to Elasticsearch, a cache, or another Delta table
- **Audit logs**: stream every row-level change to an audit table
- **Incremental ML feature computation**: recompute features only for changed entities

## Streaming Triggers

Control how frequently the stream processes data:

```python
# Process every 30 seconds (continuous micro-batching)
.trigger(processingTime="30 seconds")

# Process once and stop (useful for scheduled batch-style runs)
.trigger(once=True)

# Process all available data, then stop (Delta 2.0+, more efficient than once=True)
.trigger(availableNow=True)

# Continuous processing (experimental, sub-second latency)
.trigger(continuous="1 second")
```

`availableNow=True` is useful for migrating batch pipelines to incremental: it processes all new data since the last checkpoint and exits, behaving like a scheduled batch job but with streaming's incremental semantics.

## Compacting Streaming Tables

Streaming writes produce many small files (one or a few files per micro-batch). Run OPTIMIZE regularly to compact them:

```python
# Schedule this as a separate job, separate from the streaming job
from delta.tables import DeltaTable

delta_table = DeltaTable.forPath(spark, "s3://my-bucket/tables/events")
delta_table.optimize().executeZOrderBy("user_id", "event_type")
```

On Databricks, enable `autoCompact` to compact automatically:

```sql
ALTER TABLE events SET TBLPROPERTIES ('delta.autoOptimize.autoCompact' = 'true');
```

## Key Takeaways

- Delta Lake integrates natively with Structured Streaming — write streams as Delta commits and read Delta as a stream
- **Exactly-once** is guaranteed by combining Structured Streaming's checkpoint (Kafka offset tracking) with Delta's atomic commits and idempotent writes
- Use **`foreachBatch` + MERGE** for streaming CDC upserts — full control over write semantics with exactly-once checkpoint guarantees
- **Change Data Feed** exposes row-level `insert`, `update`, and `delete` events — ideal for downstream propagation and audit logs
- **`availableNow=True`** trigger runs incremental batch-style processing — a clean middle ground between streaming and batch
- Stream tables accumulate small files — compact with OPTIMIZE or enable `autoCompact`

---

That wraps the Delta Lake Series. You now have the foundation to build reliable, governed, high-performance data lakes: from understanding why plain Parquet fails at scale, through ACID transactions and schema enforcement, to time travel for auditability, performance tuning with Z-ordering and compaction, and unified batch-streaming pipelines with Structured Streaming and Change Data Feed.
