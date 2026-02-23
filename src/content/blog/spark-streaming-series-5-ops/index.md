---
title: "Spark Streaming Series, Part 5: Operations and Tuning"
description: "Checkpointing, fault tolerance, exactly-once semantics, monitoring, and production performance tuning."
pubDate: 2024-04-07
author: "ifkarsyah"
domain: "Streaming"
stack: ["Spark"]
image:
  src: ./spark-streaming-series.png
  alt: "Apache Spark Streaming Operations and Tuning"
---

## Checkpointing

A **checkpoint** is a snapshot of the state of a streaming query. It records:

1. The offsets read from the source (which Kafka message you are at)
2. The in-flight state (windows, user sessions, counters)
3. A metadata log for recovery

If the job crashes, Spark reads the checkpoint, recovers its offset and state, and resumes.

### Setting Up Checkpointing

Checkpoints are **required** for fault tolerance. Always specify a checkpoint location:

```python
query = result.writeStream \
    .format("delta") \
    .outputMode("append") \
    .option("checkpointLocation", "s3://my-bucket/checkpoints/events-pipeline/") \
    .option("path", "s3://my-bucket/data/events/") \
    .start()
```

The checkpoint directory is created automatically. Never commit it to version control — it is runtime state.

### Checkpoint Structure

Inside the checkpoint directory:

```
checkpoints/events-pipeline/
├── metadata.log          # metadata of all checkpoints
├── commits/
│   ├── 0                 # checkpoint for micro-batch 0
│   ├── 1                 # checkpoint for micro-batch 1
│   └── ...
└── state/
    ├── 0/               # state store partition 0
    └── 1/               # state store partition 1
```

Each checkpoint is immutable. If Spark crashes at batch 10, it replays from the last completed checkpoint (batch 9).

### Checkpoint Cleanup

Checkpoints grow over time. By default, Spark keeps the last 3 days of checkpoints. You can configure:

```python
.option("checkpointLocation", "s3://bucket/ck/") \
.option("minBatchesToRetain", 100)  # keep last 100 batches
```

For long-running jobs, consider a separate process that archives and deletes old checkpoints.

## Fault Tolerance and Exactly-Once Semantics

A Spark Streaming job can fail at any point:

- **Before a micro-batch starts**: restart, reprocess the micro-batch
- **During processing**: checkpoint not yet written, restart, reprocess
- **After processing but before writing**: checkpoint written, sink not yet written, restart, skip the micro-batch (reprocess would duplicate)

**Exactly-once** means: every event is processed and written exactly once, never dropped, never duplicated.

### Achieving Exactly-Once

You need:

1. **A replayable source** — Kafka, files, anything that can be replayed from an offset
2. **Idempotent or transactional sink** — Delta Lake, Kafka (with idempotent producer), any ACID database

Delta Lake is the standard. It is **transactional**, so writes are atomic. Reprocessing the same micro-batch writes the same data idempotently.

```python
result.writeStream \
    .format("delta") \
    .outputMode("append") \
    .option("checkpointLocation", "s3://bucket/ck/") \
    .option("path", "s3://bucket/data/") \
    .start()
```

If the job crashes between batches 5 and 6, it restarts at batch 6. The Delta write for batch 6 is idempotent — Spark detects that batch 6 already committed and skips it.

**Important**: Not all sinks support exactly-once. Console and memory sinks do not. JDBC (without careful handling) does not. Kafka sink does (if producer is idempotent).

Check the [Spark documentation](https://spark.apache.org/docs/latest/structured-streaming-programming-guide.html) for your specific sink.

## Monitoring Streaming Queries

### Query Metrics

Access a running query's status:

```python
query = result.writeStream.format("delta").start()

# Blocking call — returns when query terminates
query.awaitTermination()

# Non-blocking status check
print(query.status)
# {
#   "message": "Waiting for data to arrive",
#   "isDataAvailable": true,
#   "isTriggerActive": false
# }

# Progress: rows processed, lag, etc.
print(query.lastProgress)
# {
#   "id": "...",
#   "runId": "...",
#   "numInputRows": 1000,
#   "inputRowsPerSecond": 100,
#   "processedRowsPerSecond": 150,
#   "batchId": 10,
#   "timestamp": "2024-04-07T...",
#   "durationMs": {"addBatch": 200, "getBatch": 50, "triggerLogicalPlan": 100, ...},
#   "stateUpdates": {"numRowsUpdated": 500, "numRowsTotal": 5000}
# }
```

### Kafka Lag

For Kafka sources, monitor consumer lag (messages behind):

```python
# Lag is embedded in the source metrics
# spark.sql.streaming.kafka.offsetsBehindLatest metric
# Higher lag = you are falling behind

# Check with:
print(query.lastProgress["metrics"].get("kafka.offsetsBehindLatest"))
```

If lag is growing, your job is slower than data arrives. Scale up (more executors, larger batches) or optimize the code.

### Spark UI

The Spark UI (http://localhost:4040) has a **Streaming** tab:

- **Input Rate**: events/sec arriving from source
- **Processing Rate**: events/sec your job processes
- **Scheduling Delay**: time spent scheduling tasks
- **Processing Delay**: time to run your logic

If processing rate < input rate, lag grows. Increase resources or optimize.

## The Small-Files Problem

Each micro-batch writes a small set of files. After 1 hour of operation (every 10 seconds), that is 360 files — most tiny.

This causes problems:

- **Slow queries** — reading 360 files is slower than reading 1 file
- **Filesystem overhead** — too many inodes
- **Listing performance** — listing 1000s of files is slow

### Solution: Compaction

Delta Lake handles compaction automatically via `OPTIMIZE`:

```python
# Manually compact (after job is stopped)
spark.sql("OPTIMIZE delta.`s3://bucket/data/events/`")

# Or schedule it periodically
spark.sql("OPTIMIZE delta.`s3://bucket/data/events/` ZORDER BY timestamp")
```

This consolidates small files into fewer, larger files. ZORDER clusters by column (better for queries on that column).

For production, run compaction nightly or weekly.

## Backpressure and Resource Management

If your job is slower than data arrives, Kafka buffers messages. Eventually:

- Brokers run out of disk
- Lag grows unbounded
- Queries slow down

**Backpressure** is when the system slows down the source to match processing speed.

Spark does not have backpressure. Instead:

1. Monitor lag (use Spark UI / lastProgress)
2. If lag is growing, increase parallelism or optimize code
3. Scale up (more executors, more cores)
4. If you cannot scale, your pipeline is under-dimensioned for your load

### Scaling Example

```python
spark = SparkSession.builder \
    .appName("EventProcessor") \
    .config("spark.executor.instances", "10") \
    .config("spark.executor.cores", "4") \
    .config("spark.executor.memory", "8g") \
    .getOrCreate()
```

More executors = more parallelism = higher throughput.

## A Complete Production Pipeline

```python
from pyspark.sql import SparkSession, functions as F
from pyspark.sql.types import StructType, StructField, LongType, StringType
from pyspark.sql.streaming import Trigger

spark = SparkSession.builder \
    .appName("ProductionEventPipeline") \
    .config("spark.streaming.kafka.maxRatePerPartition", "100000") \
    .config("spark.sql.streaming.checkpointLocation.format", "checkpoint") \
    .getOrCreate()

schema = StructType([
    StructField("user_id", LongType()),
    StructField("event_type", StringType()),
])

# Read from Kafka
events = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "broker1:9092,broker2:9092") \
    .option("subscribe", "events") \
    .option("startingOffsets", "latest") \
    .load()

# Parse and enrich
parsed = events.select(
    F.from_json(F.col("value").cast("string"), schema).alias("data")
).select("data.*") \
.withColumn("ingestion_time", F.current_timestamp())

# Write to Delta Lake with exactly-once
query = parsed.writeStream \
    .format("delta") \
    .outputMode("append") \
    .option("checkpointLocation", "s3://bucket/checkpoints/events-pipeline/") \
    .option("path", "s3://bucket/data/events/") \
    .trigger(processingTime="30 seconds") \
    .start()

# Monitor
try:
    query.awaitTermination()
except KeyboardInterrupt:
    print("Stopping query...")
    query.stop()

# Periodic maintenance (run this nightly)
# spark.sql("OPTIMIZE delta.`s3://bucket/data/events/` ZORDER BY ingestion_time")
```

This is production-ready: exactly-once semantics, fault tolerance, monitoring, and planned compaction.

## Performance Checklist

When your streaming job is slow:

**Input Rate vs Processing Rate**
- Is processing rate < input rate?
- If yes, lag will grow. Increase parallelism.

**Partition Count**
- Is your Kafka topic under-partitioned?
- One partition = one reader. More partitions = parallel reads.
- Aim for 2-4 seconds of data per partition.

**Batch Interval**
- Is your trigger interval too small?
- Smaller batches = more overhead. 10-30 seconds is typical.

**State Size**
- Are you tracking unbounded state per key?
- Use timeouts to drop inactive keys.

**Sink Write Time**
- Is Delta Lake write slow?
- Check `durationMs.addBatch` in lastProgress.
- If high, increase parallelism or switch to Parquet.

**GC and Memory**
- Are executors garbage collecting frequently?
- Reduce batch size or increase executor memory.

## Key Takeaways

- Checkpointing is required for fault tolerance; specify `checkpointLocation` always
- Delta Lake provides exactly-once semantics; use it for production sinks
- Monitor via Spark UI, lastProgress, and Kafka lag
- Compact Delta tables periodically to avoid small-files problem
- Scale up if processing rate < input rate
- For production: exactly-once sinks, monitoring, resource sizing, and compaction

That wraps up the Spark Streaming series. You now have the fundamentals — unbounded tables, sources and sinks, time and state, fault tolerance, and operations. You can build production streaming pipelines and debug when things go wrong. The next step is practice: build, monitor, tune, and learn from your deployments.
