---
title: "Spark Series, Part 3: Structured Streaming"
description: "Real-time data processing with Spark Structured Streaming — micro-batches, triggers, watermarks, and output modes."
pubDate: 2024-01-28
author: "ifkarsyah"
tags: ["Spark", "Data Engineering", "Streaming", "Big Data"]
image:
  src: ./spark-series.png
  alt: "Apache Spark Structured Streaming"
---

## From Batch to Streaming

Spark started as a batch processing engine. Structured Streaming extends the DataFrame API to support continuous data — the same API, but applied to an unbounded, continuously arriving stream of records.

The key insight: treat a stream as an **unbounded table**. New records arriving on Kafka are rows appended to this table. Your Spark query runs continuously against this growing table, producing results incrementally.

This model is called **micro-batch processing** by default. Spark collects records into small batches, processes each batch as a mini Spark job, and writes the results. Latency is typically 1–10 seconds.

## Reading from a Stream

```python
from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import StructType, StructField, StringType, LongType

spark = SparkSession.builder.appName("Streaming Example").getOrCreate()

schema = StructType([
    StructField("user_id", LongType()),
    StructField("event_type", StringType()),
    StructField("timestamp", LongType()),
])

# Read from Kafka
stream_df = (
    spark.readStream
    .format("kafka")
    .option("kafka.bootstrap.servers", "broker:9092")
    .option("subscribe", "user-events")
    .option("startingOffsets", "latest")
    .load()
)

# Kafka delivers bytes — parse the value column
events = stream_df.select(
    F.from_json(F.col("value").cast("string"), schema).alias("data")
).select("data.*")
```

## Output Modes

Streaming queries must specify an output mode — how results are written as the stream progresses:

- **Append** — only new rows are written to the sink. Used when rows are never updated. Best for event logs, immutable records.
- **Update** — only changed rows are written. Used with aggregations where intermediate state changes as new data arrives.
- **Complete** — the entire result table is rewritten each micro-batch. Used for global aggregations where you always want the full picture.

```python
query = (
    events
    .groupBy("event_type")
    .count()
    .writeStream
    .outputMode("update")       # only write changed counts
    .format("console")
    .start()
)
```

## Triggers

Triggers control when Spark processes the next micro-batch:

```python
from pyspark.sql.streaming import Trigger

# Process as fast as possible (default)
.trigger(processingTime="0 seconds")

# Fixed interval — wait 30 seconds between batches
.trigger(processingTime="30 seconds")

# Process all available data, then stop (useful for backfill)
.trigger(availableNow=True)
```

For most production streaming jobs, a fixed interval of 30–60 seconds is a reasonable starting point. It balances latency against the overhead of frequent micro-batch scheduling.

## Watermarks and Late Data

In real systems, events arrive late. A user action that happened at 10:00 AM might not reach Kafka until 10:05 AM due to network delay or device buffering. If you are computing time-window aggregations, you need to decide how long to wait for late data before finalizing a window.

Watermarks handle this:

```python
from pyspark.sql import functions as F

windowed = (
    events
    .withColumn("event_time", F.to_timestamp(F.col("timestamp") / 1000))
    .withWatermark("event_time", "10 minutes")   # wait up to 10 min for late data
    .groupBy(
        F.window("event_time", "5 minutes"),      # 5-minute tumbling window
        F.col("event_type")
    )
    .count()
)
```

The watermark tells Spark: "if the current maximum event time is T, then data with event time earlier than T - 10 minutes can be discarded." Once a window is older than the watermark threshold, it is finalized and state is dropped.

Setting the watermark too short means late data is dropped. Too long means Spark holds more state in memory. Profile your source's latency distribution and set accordingly.

## Checkpointing and Fault Tolerance

Structured Streaming provides exactly-once guarantees (with compatible sinks) through checkpointing. Checkpoint state is written to durable storage (HDFS, S3) after each micro-batch.

```python
query = (
    windowed
    .writeStream
    .outputMode("update")
    .format("delta")
    .option("checkpointLocation", "s3://my-bucket/checkpoints/user-events/")
    .option("path", "s3://my-bucket/output/user-events/")
    .trigger(processingTime="30 seconds")
    .start()
)

query.awaitTermination()
```

If the job crashes and restarts, it reads the checkpoint to recover its offset position and in-flight state, then resumes from where it left off.

Never share checkpoint directories between different queries. Each query needs its own checkpoint path.

## Common Pitfalls

**Forgetting to set a watermark with windowed aggregations.** Without a watermark, Spark keeps state for all open windows indefinitely. Memory usage grows without bound.

**Using `complete` output mode without understanding the cost.** Complete mode rewrites the entire result set each micro-batch. For large aggregations, this is very expensive.

**Too many small files.** Each micro-batch writes a small set of files. After hours of operation, you can have thousands of tiny files. Run a compaction job periodically (Delta Lake handles this automatically with OPTIMIZE).

**Not monitoring consumer lag.** If your streaming job processes data slower than it arrives, Kafka lag will grow. Monitor it and scale up or tune accordingly.

## Key Takeaways

- Structured Streaming uses the same DataFrame API as batch, applied to an unbounded stream
- Default mode is micro-batch; latency is seconds, not milliseconds
- Choose output mode based on your semantics: append for immutable data, update for aggregations
- Always set watermarks for time-window aggregations to bound state size
- Checkpointing is required for fault tolerance and exactly-once delivery

Next: the final part — performance tuning and the most common Spark bottlenecks.
