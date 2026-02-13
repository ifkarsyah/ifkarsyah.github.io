---
title: "How Flink's Exactly-Once Semantics Actually Work"
description: "A deep dive into Flink's checkpointing mechanism and how it guarantees exactly-once processing even when jobs fail and restart."
pubDate: 2023-11-20
author: "ifkarsyah"
tags: ["Apache Flink", "Streaming", "Data Platform"]
image:
  src: /blog/flink.png
  alt: "Apache Flink"
---

## The Problem with Streaming

In a streaming system, failures are not exceptions — they are the norm. A job restarts, a network blips, a downstream sink times out. The question is: what happens to the data in flight?

There are three possible guarantees:
- **At-most-once** — data may be lost, never duplicated
- **At-least-once** — data may be duplicated, never lost
- **Exactly-once** — data is processed precisely once, even across failures

Flink provides exactly-once end-to-end, which is surprisingly hard to achieve in a distributed system.

## Chandy-Lamport Snapshots

Flink's checkpointing is based on the Chandy-Lamport algorithm for distributed snapshots. The key insight: you don't need to stop the world to take a consistent snapshot. You just need to inject a marker (a "barrier") into the data stream.

```
Source → [data] [data] [BARRIER-42] [data] [data] →
```

When an operator receives a barrier:
1. It finishes processing all data that arrived before the barrier
2. It snapshots its own state to durable storage (S3, HDFS, etc.)
3. It forwards the barrier downstream

When all operators have processed barrier 42, checkpoint 42 is complete. Flink now knows: "if I restart from this checkpoint, I can replay from Kafka offset X and the world will be consistent."

## Two-Phase Commit for Sinks

Exactly-once at the source is not enough — you also need the sink to not write duplicates on restart. Flink handles this with a two-phase commit protocol for transactional sinks.

For a Kafka sink:
1. **Pre-commit** — on checkpoint, open a Kafka transaction and buffer records
2. **Commit** — when checkpoint completes successfully, commit the Kafka transaction
3. **Abort** — if the job fails before commit, the transaction is rolled back

```python
# Flink's KafkaSink uses exactly-once by default
sink = KafkaSink.builder() \
    .set_bootstrap_servers("kafka:9092") \
    .set_record_serializer(...) \
    .set_delivery_guarantee(DeliveryGuarantee.EXACTLY_ONCE) \
    .build()
```

## The Trade-off

Exactly-once isn't free. Checkpointing adds latency (you wait for state to flush to storage), and two-phase commit holds Kafka transactions open between checkpoints, which can cause consumer lag to appear inflated.

For most use cases, a checkpoint interval of 1–5 minutes is a reasonable balance between recovery granularity and overhead.

## Conclusion

Flink's exactly-once guarantee is elegant: instead of coordinating a global snapshot, it injects lightweight barriers into the stream and lets each operator checkpoint asynchronously. The result is a system that recovers cleanly from failures without double-counting or data loss — which is exactly what you need when your data drives financial reports or user-facing metrics.
