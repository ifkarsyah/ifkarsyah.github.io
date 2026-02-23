---
title: "Spark Streaming Series, Part 3: Time, Watermarks, and Windows"
description: "Event time vs processing time, watermarks to handle late data, and window types for time-based aggregations."
pubDate: 2024-03-24
author: "ifkarsyah"
domain: "Streaming"
stack: ["Spark"]
image:
  src: ./spark-streaming-series.png
  alt: "Apache Spark Streaming Time and Windows"
---

## Event Time vs Processing Time

When you aggregate streaming data over time, you must decide: **which time do I use?**

**Processing time**: The wall-clock time when Spark processes the event. Fast and simple, but wrong for most analytics.

**Event time**: The actual time the event happened, embedded in the data. Slower to implement correctly, but essential for analytics.

### Example: Counting Events Per Hour

A user clicks a link at 10:00 AM (event time). Due to network delay, the click reaches Kafka at 10:05 AM (processing time). The job processes it at 10:06 AM.

Which hour should the click count toward?

- **Processing time**: 10:06 hour. Incorrect — the click happened at 10:00.
- **Event time**: 10:00 hour. Correct — the click belongs to the 10:00 hour.

For **real** analytics (customer behavior, fraud detection, dashboards), you must use event time.

## Event Time Extraction

Your events include a **timestamp column** with the event time. Extract it:

```python
from pyspark.sql import functions as F

# Events arrive as JSON with a timestamp field (milliseconds since epoch)
parsed = spark.readStream \
    .format("kafka") \
    ...
    .load()

# Extract the event time as a timestamp
events = parsed.select(
    F.from_json(F.col("value").cast("string"), schema).alias("data")
).select("data.*") \
.withColumn("event_time", F.to_timestamp(F.col("timestamp") / 1000))
```

Now **event_time** is a proper timestamp column. Windows will use this.

## Watermarks: Handling Late Data

In real systems, events arrive **late**. A mobile user on a slow connection, a log file delivered hours later, network congestion — all cause delays.

If your event happened at 10:00 AM but arrives at 10:30 AM, should it count in the 10:00-11:00 window?

**Watermarks** answer this. A watermark is a threshold: "data older than T - 10 minutes can be dropped."

### Using Watermarks

```python
windowed = events \
    .withWatermark("event_time", "10 minutes") \
    .groupBy(
        F.window("event_time", "1 hour"),  # 1-hour tumbling window
        F.col("event_type")
    ) \
    .count()
```

The **watermark** says: "wait up to 10 minutes for late data." If the current max event time is 10:30, data older than 10:20 is dropped.

### How Watermarks Affect State

Without a watermark, Spark keeps state for **all open windows indefinitely**. Memory grows without bound.

With a watermark, Spark drops state for windows older than watermark - 1 window size. Memory is bounded.

```
Event time = 10:30
Watermark threshold = 10:30 - 10 min = 10:20

Windows still open:
  - 09:00-10:00 (older than threshold, dropped)
  - 10:00-11:00 (within threshold, kept)
  - 10:30-11:30 (active, kept)
```

**Setting the watermark correctly is critical:**

- **Too short** (1 minute): Late data is dropped, results are incomplete.
- **Too long** (2 hours): Memory bloats as state is kept for hours.
- **Just right** (10-30 minutes): Based on your source's latency distribution. Measure it.

## Window Types

### Tumbling Windows

Non-overlapping fixed windows. Each event belongs to exactly one window.

```python
# 1-hour tumbling windows: [00:00-01:00), [01:00-02:00), ...
F.window("event_time", "1 hour")

# 5-minute windows
F.window("event_time", "5 minutes")
```

Common for dashboards: "counts per hour", "revenue per day."

### Sliding Windows

Overlapping fixed windows. Each event belongs to multiple windows.

```python
# 1-hour window, slides every 10 minutes
# [00:00-01:00), [00:10-01:10), [00:20-01:20), ...
F.window("event_time", "1 hour", "10 minutes")
```

More computation, more storage. Use when you need fine-grained trends.

### Session Windows

Dynamic windows defined by **inactivity**. A session ends when no events arrive for a threshold period.

```python
from pyspark.sql.functions import session_window

# Session ends after 30 minutes of inactivity
sessions = events \
    .groupBy(
        F.col("user_id"),
        session_window("event_time", "30 minutes")
    ) \
    .count()
```

Example: A user is active from 10:00-10:30 (30 events). Then silent for 30+ minutes. Then active again 11:05-11:20. That's **two sessions**.

Session windows are powerful for user behavior analysis, but computationally expensive.

## A Complete Example: Hourly Event Counts

```python
from pyspark.sql import SparkSession, functions as F
from pyspark.sql.types import StructType, StructField, LongType, StringType

spark = SparkSession.builder.appName("EventCounting").getOrCreate()

schema = StructType([
    StructField("event_type", StringType()),
    StructField("timestamp", LongType()),  # milliseconds since epoch
])

# Read from Kafka
raw = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "broker:9092") \
    .option("subscribe", "events") \
    .load()

# Parse and extract event time
events = raw.select(
    F.from_json(F.col("value").cast("string"), schema).alias("data")
).select("data.*") \
.withColumn("event_time", F.to_timestamp(F.col("timestamp") / 1000))

# Windowed aggregation with watermark
hourly = events \
    .withWatermark("event_time", "15 minutes") \
    .groupBy(
        F.window("event_time", "1 hour"),
        F.col("event_type")
    ) \
    .count() \
    .withColumn("window_start", F.col("window.start")) \
    .withColumn("window_end", F.col("window.end")) \
    .select("window_start", "window_end", "event_type", "count")

# Write to console for demo
query = hourly.writeStream \
    .outputMode("update") \
    .format("console") \
    .trigger(processingTime="10 seconds") \
    .start()

query.awaitTermination()
```

Output (every 10 seconds, showing updated windows):

```
+-------------------+-------------------+----------+-----+
|     window_start   |     window_end     |event_type|count|
+-------------------+-------------------+----------+-----+
|2024-03-24 10:00:00|2024-03-24 11:00:00|   login  | 523 |
|2024-03-24 10:00:00|2024-03-24 11:00:00|  logout  | 451 |
|2024-03-24 11:00:00|2024-03-24 12:00:00|   login  | 610 |
+-------------------+-------------------+----------+-----+
```

## Late Data Behavior

With a watermark of 15 minutes and an event arriving 30 minutes late:

- The event is **dropped** — it is older than the watermark threshold.
- Results for that window are **finalized** — no more updates.

With a watermark of 1 hour and the same event:

- The event is **included** — it is within the threshold.
- The window is **reopened** for update.

This is why choosing the watermark correctly matters.

## Gotchas

**Forgetting the watermark**: Without it, Spark keeps all window state. Memory grows unbounded. Always use watermarks with windows.

**Wrong time column**: If you watermark on processing time (`F.current_timestamp()`) instead of event time, you lose the benefit of event-time semantics.

**Assuming watermarks are hard guarantees**: They are not. Data older than the watermark *can* be dropped, but it is not guaranteed. Some systems (Flink) have stronger guarantees; Spark does not.

## Key Takeaways

- Event time (from data) is correct for analytics; processing time is convenient but wrong
- Watermarks bound state size by dropping windows older than watermark - window size
- Set watermarks based on your source's latency distribution; 10-30 minutes is typical
- Tumbling windows for non-overlapping periods, sliding for fine-grained trends, session windows for user behavior
- Always use watermarks with windowed aggregations — without them, state grows unbounded

**Next:** [Stateful Operations](/blog/spark-streaming-series-4-stateful)
