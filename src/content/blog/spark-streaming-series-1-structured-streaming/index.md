---
title: "Spark Streaming Series, Part 1: Structured Streaming Fundamentals"
description: "The unbounded table model — how Spark Streaming treats streams as infinite DataFrames, with output modes, triggers, and writing."
pubDate: 2024-03-10
author: "ifkarsyah"
domain: "Streaming"
stack: ["Spark"]
image:
  src: ./spark-streaming-series.png
  alt: "Apache Spark Structured Streaming"
---

## The Unbounded Table Model

The core insight of Structured Streaming is simple: **treat a stream as an infinite table that grows with each new event**.

When a user clicks a button, a new row is appended to your **events** table. When an IoT device sends temperature data, another row arrives. Your Spark query runs continuously against this growing table.

```
Time T0:  events = [row1]           => result = [agg1]
Time T1:  events = [row1, row2]     => result = [agg1, agg2]
Time T2:  events = [row1, row2, r3] => result = [agg1, agg2, agg3]
                 (new rows appended)
```

This mental model is what makes Structured Streaming intuitive: the SQL is the same as batch. Only the source is unbounded.

## SparkSession for Streaming

Structured Streaming uses the same **SparkSession** as batch Spark. The difference is in how you read and write.

```python
from pyspark.sql import SparkSession

spark = SparkSession.builder \
    .appName("StreamingApp") \
    .getOrCreate()
```

No new session type, no special configuration. A single line signals that you will use streaming: `.readStream` instead of `.read`.

## Reading a Stream

Reading a stream is nearly identical to reading a batch, with one method name change:

```python
# Batch (one-time read)
df = spark.read.format("kafka").option(...).load()

# Streaming (continuous read)
stream_df = spark.readStream.format("kafka").option(...).load()
```

The **stream_df** is a DataFrame, but it is **unbounded**. You cannot call `.show()` on it directly — there are infinite rows coming. Instead, you build a query and start it with `.start()`.

### A Complete Example

```python
# Read from Kafka
events = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "localhost:9092") \
    .option("subscribe", "events") \
    .option("startingOffsets", "latest") \
    .load()

# Parse the Kafka message (JSON in the value column)
from pyspark.sql.types import StructType, StructField, StringType, LongType

schema = StructType([
    StructField("user_id", LongType()),
    StructField("event_type", StringType()),
    StructField("timestamp", LongType()),
])

parsed = events.select(
    F.from_json(F.col("value").cast("string"), schema).alias("data")
).select("data.*")

# Now parsed is a streaming DataFrame with columns: user_id, event_type, timestamp
```

Kafka delivers message value as raw bytes. `from_json` parses the JSON into columns. This pattern is universal for Kafka sources.

## Output Modes

A streaming query must specify **how** results are written. Spark supports three output modes:

### Append Mode

Only **new rows** are written to the sink. Used when rows never change.

```python
parsed \
    .filter(F.col("event_type") == "login") \
    .writeStream \
    .outputMode("append") \
    .format("console") \
    .start()
```

Every time a login event arrives, one row is written. Perfect for immutable event logs.

### Update Mode

Only **changed rows** are written. Used with aggregations — when intermediate results change.

```python
aggregated = parsed \
    .groupBy("user_id") \
    .count()

aggregated \
    .writeStream \
    .outputMode("update") \
    .format("console") \
    .start()
```

When user_id=123 has 5 events, then 6 events, only the updated row (user_id=123, count=6) is written. Intermediate state is maintained by Spark; you only see deltas.

### Complete Mode

The **entire result set** is rewritten each trigger. Used for global aggregations where you want the full picture.

```python
global_count = parsed \
    .select(F.lit("total") as "group") \
    .groupBy("group") \
    .count()

global_count \
    .writeStream \
    .outputMode("complete") \
    .format("console") \
    .start()
```

Every trigger, the global count is recalculated and rewritten. Expensive, but useful for small aggregations.

**Which mode to use?** Append for facts (events), Update for incremental aggregations, Complete for global rollups.

## Triggers

A **trigger** controls when Spark processes the next micro-batch.

### Processing Time (Default)

```python
from pyspark.sql.streaming import Trigger

# Process as soon as the previous batch finishes (no wait)
.trigger(processingTime="0 seconds")

# Wait 30 seconds between micro-batches
.trigger(processingTime="30 seconds")
```

If your data arrives at 100 events/second and you trigger every 30 seconds, each batch has ~3000 events. Latency is 30 seconds (plus processing time).

Processing-time triggers are robust: they do not depend on event timestamps, only wall-clock time.

### Available Now (Backfill)

```python
# Process all available data, then stop
.trigger(availableNow=True)
```

Useful for backfilling historical data or testing. Spark reads everything available and stops — not continuous.

### Continuous Mode (Experimental)

```python
# True continuous processing (millisecond latency)
.trigger(Trigger.Continuous("1 second"))
```

Spark processes data continuously, not in micro-batches. Experimental and rarely used in production; stick with processing-time triggers.

## Writing a Stream

Writing is the opposite of reading. Use `.writeStream` instead of `.write`:

```python
query = parsed \
    .writeStream \
    .format("console") \
    .outputMode("append") \
    .trigger(processingTime="10 seconds") \
    .start()
```

The call to `.start()` returns a **StreamingQuery** object. The query runs in the background.

### A Complete Pipeline

```python
from pyspark.sql import SparkSession, functions as F
from pyspark.sql.types import StructType, StructField, StringType, LongType
from pyspark.sql.streaming import Trigger

spark = SparkSession.builder.appName("EventProcessor").getOrCreate()

schema = StructType([
    StructField("user_id", LongType()),
    StructField("event_type", StringType()),
])

events = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "broker:9092") \
    .option("subscribe", "events") \
    .load()

parsed = events.select(
    F.from_json(F.col("value").cast("string"), schema).alias("data")
).select("data.*")

# Count events by type
result = parsed \
    .groupBy("event_type") \
    .count()

# Write continuously
query = result \
    .writeStream \
    .outputMode("update") \
    .format("console") \
    .trigger(processingTime="10 seconds") \
    .start()

query.awaitTermination()  # Block until the query terminates (or Ctrl-C)
```

Run this and every 10 seconds you see the updated event counts.

## Key Takeaways

- Structured Streaming treats a stream as an unbounded table growing with each new event
- `.readStream` and `.writeStream` are the only syntactic differences from batch
- Output modes (append, update, complete) determine how results are written
- Triggers (processingTime, availableNow) control when micro-batches are processed
- A complete streaming query is: source → transformations → output mode → trigger → start

Next: Sources and Sinks — how to read from Kafka and other sources, and where to write results.
