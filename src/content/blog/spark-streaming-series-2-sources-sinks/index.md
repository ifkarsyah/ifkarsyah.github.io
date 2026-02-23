---
title: "Spark Streaming Series, Part 2: Sources and Sinks"
description: "Reading from Kafka and files, writing to Delta Lake and databases — the connectors that power real-time pipelines."
pubDate: 2024-03-17
author: "ifkarsyah"
domain: "Streaming"
stack: ["Spark"]
image:
  src: ./spark-streaming-series.png
  alt: "Apache Spark Streaming Sources and Sinks"
---

## The Source-Processor-Sink Pattern

A streaming pipeline has three parts:

1. **Source** — where data comes from (Kafka, files, a rate generator)
2. **Processor** — your Spark logic (filters, aggregations, joins)
3. **Sink** — where results go (Delta Lake, Kafka, databases)

This part covers sources and sinks. The processor is just Spark SQL — you already know that.

## Sources: Reading Streams

### Kafka Source

Kafka is the standard source for streaming data. Every Kafka topic is an unbounded stream of messages.

```python
events = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "broker1:9092,broker2:9092") \
    .option("subscribe", "user-events,page-views") \
    .option("startingOffsets", "latest") \
    .load()
```

The Kafka source delivers each message as:
- **key** (bytes)
- **value** (bytes)
- **topic** (string)
- **partition** (int)
- **offset** (long)
- **timestamp** (long)

### Key Options

**subscribe** vs **assign**: Subscribe to topics by name (most common). Assign to specific partitions (rare, for advanced control).

```python
# Subscribe to topics (consumer group manages offsets)
.option("subscribe", "topic1,topic2")

# Assign to specific partitions (manual offset management)
.option("assign", '{"topic1":[0,1], "topic2":[2]}')
```

**startingOffsets**: Where to begin when the job starts.

```python
.option("startingOffsets", "latest")      # from the end (newest data)
.option("startingOffsets", "earliest")    # from the beginning (reprocess all history)
.option("startingOffsets", '{"topic1":{"0":100}}')  # specific offset per partition
```

**failOnDataLoss**: Crash if offsets are lost (brokers overflowed old data).

```python
.option("failOnDataLoss", "false")  # ignore data loss and continue (risky)
```

### Parsing Kafka Messages

Kafka messages are raw bytes. You must parse them:

```python
from pyspark.sql.types import StructType, StructField, StringType, LongType, DoubleType
from pyspark.sql import functions as F

schema = StructType([
    StructField("user_id", LongType()),
    StructField("event_type", StringType()),
    StructField("value", DoubleType()),
    StructField("timestamp", LongType()),
])

# Kafka delivers value as bytes; cast to string, parse JSON
events = spark.readStream.format("kafka") \
    .option("kafka.bootstrap.servers", "broker:9092") \
    .option("subscribe", "events") \
    .load()

parsed = events.select(
    F.from_json(F.col("value").cast("string"), schema).alias("data")
).select("data.*")
```

For other formats (Avro, Protobuf), Spark has dedicated functions. JSON is most common.

### File Source

Read new files as they arrive in a directory:

```python
files = spark.readStream \
    .format("parquet") \
    .option("path", "/data/incoming") \
    .option("maxFilesPerTrigger", 1) \
    .load()
```

The file source watches a directory and processes new files in each micro-batch. Useful for data dumps from external systems.

**maxFilesPerTrigger**: How many files to read per batch. Smaller = lower latency, more batches.

### Rate Source (Testing)

Generate synthetic events at a fixed rate:

```python
events = spark.readStream \
    .format("rate") \
    .option("rowsPerSecond", 100) \
    .option("numPartitions", 4) \
    .load()
```

Generates `rowsPerSecond` events, each with a timestamp and a sequential id. Perfect for testing without Kafka.

## Sinks: Writing Results

### Console Sink (Testing)

Write to stdout:

```python
result.writeStream \
    .format("console") \
    .outputMode("append") \
    .start()
```

Useful for debugging. Shows results as they are computed.

### Memory Sink (Testing)

Store results in memory:

```python
result.writeStream \
    .format("memory") \
    .outputMode("append") \
    .queryName("my_result") \
    .start()

# Later, query the in-memory table
spark.sql("SELECT * FROM my_result").show()
```

Good for unit tests. The table persists across queries.

### Kafka Sink (Event Streaming)

Write results back to Kafka:

```python
result.writeStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "broker:9092") \
    .option("topic", "results") \
    .option("checkpointLocation", "s3://bucket/checkpoint/") \
    .start()
```

The **value** column is serialized to JSON and sent. The **key** column (if present) sets the message key.

```python
result_keyed = result.select(
    F.col("user_id").cast("string").alias("key"),
    F.to_json(F.struct("*")).alias("value")
)

result_keyed.writeStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "broker:9092") \
    .option("topic", "results") \
    .option("checkpointLocation", "s3://bucket/checkpoint/") \
    .start()
```

### Delta Lake Sink (Production)

Write to a Delta table:

```python
result.writeStream \
    .format("delta") \
    .outputMode("append") \
    .option("checkpointLocation", "s3://bucket/checkpoint/") \
    .mode("append") \
    .option("path", "s3://bucket/data/results") \
    .start()
```

Or using a named table:

```python
result.writeStream \
    .format("delta") \
    .outputMode("append") \
    .option("checkpointLocation", "s3://bucket/checkpoint/") \
    .toTable("results")  # creates or appends to the table
```

Delta Lake is the **production standard** for Spark. It provides:

- **ACID transactions** — updates are atomic
- **Time travel** — query historical snapshots
- **Schema enforcement** — reject incompatible writes
- **Compaction** — automatic and via OPTIMIZE
- **Cheap deletes** — mark rows deleted without rewriting

Always use Delta for production sinks.

### JDBC Sink (Databases)

Write to a SQL database via JDBC. Structured Streaming does **not** have native JDBC sink support. Use **foreach**:

```python
def write_to_db(df, epoch_id):
    df.write.format("jdbc") \
        .option("url", "jdbc:postgresql://localhost/mydb") \
        .option("dbtable", "results") \
        .option("user", "postgres") \
        .option("password", "...") \
        .mode("append") \
        .save()

result.writeStream \
    .foreachBatch(write_to_db) \
    .outputMode("append") \
    .start()
```

The `.foreachBatch()` sink calls your function for each micro-batch as a DataFrame. Inside, you can use any batch write logic.

### Foreach Sink (Custom Logic)

For custom processing (HTTP calls, logging, caching):

```python
def process_row(row):
    # Send to an API, log, etc.
    print(f"Processing: {row}")

result.writeStream \
    .foreach(process_row) \
    .outputMode("append") \
    .start()
```

This calls `process_row` for each individual row. Useful but slower than batch-oriented sinks.

## Complete Example: Kafka to Delta Lake

```python
from pyspark.sql import SparkSession, functions as F
from pyspark.sql.types import StructType, StructField, LongType, StringType

spark = SparkSession.builder.appName("KafkaToDeltalake").getOrCreate()

schema = StructType([
    StructField("user_id", LongType()),
    StructField("event_type", StringType()),
])

# Read from Kafka
events = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "broker:9092") \
    .option("subscribe", "events") \
    .option("startingOffsets", "latest") \
    .load()

# Parse JSON
parsed = events.select(
    F.from_json(F.col("value").cast("string"), schema).alias("data")
).select("data.*")

# Transform
enriched = parsed \
    .withColumn("ingestion_time", F.current_timestamp()) \
    .filter(F.col("event_type") != "test")

# Write to Delta Lake
query = enriched.writeStream \
    .format("delta") \
    .outputMode("append") \
    .option("checkpointLocation", "s3://bucket/ck/events/") \
    .option("path", "s3://bucket/data/events/") \
    .trigger(processingTime="30 seconds") \
    .start()

query.awaitTermination()
```

Run this and every 30 seconds, new events from Kafka are parsed, transformed, and written to Delta Lake with exactly-once semantics.

## Key Takeaways

- Kafka is the standard unbounded source; configure with `subscribe`, `startingOffsets`
- Kafka messages are bytes; parse with `from_json(value.cast("string"), schema)`
- Sources: Kafka, files, rate (for testing)
- Sinks: Delta Lake (production), Kafka (streaming), console/memory (testing), JDBC (via foreachBatch)
- Delta Lake provides ACID, time travel, and schema enforcement — use it for production
- Check for checkpoint locations; every writeStream must have one

Next: Time, Watermarks, and Windows — how to compute aggregations over time windows and handle late-arriving data.
