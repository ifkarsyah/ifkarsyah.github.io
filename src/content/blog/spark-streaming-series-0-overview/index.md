---
title: "Spark Streaming Series, Part 0: Overview"
description: "Stream processing with Apache Spark — from basics to Structured Streaming, the modern architecture for real-time data pipelines."
pubDate: 2024-03-03
author: "ifkarsyah"
domain: "Streaming"
stack: ["Spark"]
image:
  src: ./spark-streaming-series.png
  alt: "Apache Spark Streaming"
---

## What Is Stream Processing?

Stream processing is the continuous analysis of unbounded data. Instead of waiting for a batch job to run on yesterday's data, a streaming system reacts to events *as they arrive* — processing a user click, an IoT sensor reading, a financial transaction in milliseconds or seconds.

**Batch processing** (the traditional approach): collect data, store it, run a job, get results tomorrow.

**Stream processing** (real-time): data arrives continuously, you process it immediately, results are available now.

For many modern applications — real-time dashboards, fraud detection, recommendation systems, alerting — stream processing is not optional.

## Why Spark for Streaming?

Apache Spark is a massive distributed computation engine. You likely already know it for batch jobs (DataFrames, SQL, machine learning). Spark Streaming extends that same API to unbounded streams.

**Key advantages:**

- **Same API as batch.** If you know Spark's DataFrame API, you already know 90% of Spark Streaming. No new language, no context switching.
- **Ecosystem integration.** Connect to Kafka, read from Delta Lake, write to S3 — all using the same tools and patterns you use for batch.
- **Exactly-once semantics.** With compatible sinks, Spark guarantees you won't lose or duplicate data, even if the job crashes.
- **Stateful processing.** Track per-key state across events — user sessions, cumulative counters, real-time aggregations.

**The tradeoff:** Spark's default mode is **micro-batch** processing. Data is collected into small batches (typically 1–10 seconds) and processed as mini Spark jobs. Latency is seconds, not milliseconds. If you need sub-second latency, Flink or Kafka Streams are better fits.

## DStreams: The Deprecated Approach

Spark's original streaming API was called **DStreams** (Discretized Streams). It treated a stream as a sequence of small RDDs. It was functional and worked, but had limitations:

- No event-time semantics — only processing time
- No exactly-once guarantee
- Less intuitive than DataFrames
- Deprecated as of Spark 3.0

You will still see DStreams in older codebases. Don't use them for new work. **Structured Streaming is the present and future.**

## Structured Streaming: The Modern Answer

Structured Streaming (introduced in Spark 2.0, now mature) is Spark's answer to stream processing done right. The key insight: **treat a stream as an unbounded table**.

Your Kafka topic is a table that grows with each message. Your Spark query runs continuously against this table, producing results incrementally. The syntax is identical to batch SQL — you just use `.readStream` instead of `.read`.

This model is clean, intuitive, and aligns with how data engineers think about data.

## Spark Streaming vs Flink: When NOT to Use Spark

Spark Streaming excels at **complex transformations at scale** (joins, aggregations, stateful logic) on **organized** sources like Kafka. Flink excels at **low latency** and **event-time semantics out of the box**.

| Aspect | Spark Streaming | Flink |
|---|---|---|
| Latency | Seconds (micro-batch default) | Milliseconds (true streaming) |
| Exactly-once | Yes (with compatible sinks) | Yes (native) |
| Event time | Yes | Yes (built-in, simpler) |
| Stateful ops | Rich, per-key state | Rich, per-key state |
| Learning curve | Low (same as batch Spark) | Steep (new paradigm) |
| Ecosystem | Delta Lake, MLlib, SQL | Kafka, databases |

**Use Spark Streaming if:** You know Spark, need complex logic, can tolerate second-level latency, and want ecosystem integration.

**Use Flink if:** You need sub-second latency, want event-time handling out of the box, or are building a dedicated streaming platform.

## Architecture: How Structured Streaming Works

```
Input Source        Spark Streaming Engine      Output Sink
(Kafka)    -->   (micro-batch processor)  -->  (Delta Lake)
  |                     |                           |
  |                     |-- Task 1                   |
  |-- State Store  -->  |-- Task 2  -->  State -->  |
  |                     |-- Task 3
  |              Checkpoint (HDFS/S3)
```

A Structured Streaming query runs **continuously**. Each micro-batch (by default every 1–10 seconds):

1. Read a batch of records from the source
2. Apply your transformations (filter, join, aggregate)
3. Update state (if any)
4. Write results to the sink
5. Write a checkpoint (for recovery)

If the job crashes and restarts, it reads the checkpoint and resumes from the exact point of failure.

## The Series Roadmap

This series covers Structured Streaming from first principles to production operations:

- **Part 0** — Overview and context (you are here)
- **Part 1** — Structured Streaming Fundamentals: the unbounded table model, output modes, triggers, reading and writing streams
- **Part 2** — Sources and Sinks: Kafka, files, Delta Lake, and how to configure them
- **Part 3** — Time, Watermarks, and Windows: event time vs processing time, handling late data, tumbling/sliding/session windows
- **Part 4** — Stateful Processing: per-key state management, timeouts, RocksDB
- **Part 5** — Operations and Tuning: checkpointing, fault tolerance, monitoring, performance, the small-files problem

After Part 5, you will have deep knowledge of Spark Streaming. You will be able to build production pipelines, debug performance issues, and reason about correctness.

## Prerequisites

To get the most from this series:

- **Spark DataFrame API** — comfortable with `select`, `filter`, `groupBy`, `join`
- **Kafka basics** — producers, topics, consumers, offsets
- **Distributed systems intuition** — failure modes, checkpointing, state management
- **Python or Scala** — examples will be in PySpark

You do not need to have used Spark Streaming before. That is the point.

**Next:** [Structured Streaming](/blog/spark-streaming-series-1-structured-streaming)
