---
title: "Flink Series, Part 4: Exactly-Once & Checkpointing"
description: "How Flink guarantees end-to-end correctness after failures — Chandy-Lamport barriers, two-phase commit, checkpoints vs savepoints."
pubDate: 2024-03-03
author: "ifkarsyah"
domain: "Streaming"
stack: ["Flink"]
image:
  src: ./flink-series.png
  alt: "Apache Flink Exactly-Once Checkpointing"
---

## The Failure Problem

In a streaming system, failures are not exceptions — they are the norm. A TaskManager crashes, a network partition occurs, a downstream sink times out. The question is not *whether* your job will fail, but *what happens to the data in flight when it does*.

There are three possible delivery guarantees:
- **At-most-once** — data may be lost, never duplicated (simplest, least correct)
- **At-least-once** — data may be duplicated, never lost
- **Exactly-once** — data is processed precisely once, even across failures (hardest, most correct)

Flink provides **exactly-once end-to-end**, which is one of its most compelling differentiators from other stream processors.

## Checkpointing: The Chandy-Lamport Algorithm

Flink's checkpointing is based on the Chandy-Lamport algorithm for distributed snapshots. The key insight: you do not need to stop the world to take a consistent snapshot. You inject a **barrier** — a special marker — into the data stream.

```
Source → [event] [event] [BARRIER-42] [event] [event] →
```

When an operator receives barrier 42:
1. It finishes processing all events that arrived *before* the barrier
2. It snapshots its own state to durable storage (S3, HDFS, GCS)
3. It forwards the barrier downstream

When all operators have processed barrier 42 and written their state, **checkpoint 42 is complete**. Flink records: "if I restart from checkpoint 42, I can replay from Kafka offset X and the world will be consistent."

If the job fails, Flink restarts from the last successful checkpoint and replays events from the corresponding source offsets. State is restored from the snapshot; processing continues as if nothing happened.

## Enabling Checkpointing

```python
from pyflink.datastream.checkpoint_config import CheckpointingMode

env.enable_checkpointing(60_000)  # every 60 seconds
env.get_checkpoint_config().set_checkpointing_mode(CheckpointingMode.EXACTLY_ONCE)
env.get_checkpoint_config().set_min_pause_between_checkpoints(30_000)
env.get_checkpoint_config().set_checkpoint_timeout(20_000)
env.get_checkpoint_config().set_max_concurrent_checkpoints(1)

# Configure checkpoint storage (remote durable store)
from pyflink.datastream.checkpoint_storage import FileSystemCheckpointStorage
env.get_checkpoint_config().set_checkpoint_storage(
    FileSystemCheckpointStorage("s3://my-bucket/flink-checkpoints")
)
```

Key settings:
- **Interval**: how often checkpoints run. Shorter = faster recovery, more overhead. 1–5 minutes is typical.
- **Min pause**: ensure the job spends time processing, not just checkpointing.
- **Timeout**: if a checkpoint takes longer than this, it is aborted (prevents the job from stalling).

## Two-Phase Commit for Sinks

Checkpointing makes the *processing* exactly-once. But if your sink can write duplicates on restart (e.g., appending to a file or sending to Kafka), end-to-end exactly-once requires more.

Flink uses a **two-phase commit (2PC)** protocol for transactional sinks:

1. **Pre-commit** (triggered at checkpoint barrier): the sink opens a transaction and buffers records without committing
2. **Commit** (triggered when checkpoint completes): the sink commits the transaction, making records visible
3. **Abort** (if job fails before commit): the transaction is rolled back; records disappear

For Kafka:
```python
from pyflink.datastream.connectors.kafka import KafkaSink, DeliveryGuarantee

sink = KafkaSink.builder() \
    .set_bootstrap_servers("kafka:9092") \
    .set_record_serializer(...) \
    .set_delivery_guarantee(DeliveryGuarantee.EXACTLY_ONCE) \
    .set_transactional_id_prefix("my-job") \
    .build()
```

With `EXACTLY_ONCE`, Flink's Kafka sink uses Kafka transactions under the hood. Records written between checkpoints are held in an open transaction. Only when the checkpoint is confirmed does Flink commit the transaction.

Note: Kafka consumers must set `isolation.level=read_committed` to see only committed records.

## Savepoints vs Checkpoints

Both are state snapshots, but they serve different purposes:

| | Checkpoint | Savepoint |
|---|---|---|
| Purpose | Automatic failure recovery | Manual operational control |
| Triggered | Automatically by Flink | Manually by operator |
| Retained after job ends | No (by default) | Yes |
| Use case | Restart after crash | Upgrade job, rebalance, A/B |

**Savepoints** are triggered manually:
```bash
flink savepoint <job-id> s3://my-bucket/savepoints/
```

You can then restart your job from a savepoint after deploying a new version:
```bash
flink run -s s3://my-bucket/savepoints/sp-123 my-job.jar
```

This is how you deploy Flink job upgrades with zero data loss — stop the job, take a savepoint, deploy the new version, restart from the savepoint.

## The Trade-offs

Exactly-once is not free:

- **Checkpoint latency**: operators must flush state to durable storage before the barrier can proceed. With large state (RocksDB), this can add 1–30 seconds.
- **Kafka transaction overhead**: records are not visible to consumers until the transaction commits (one checkpoint interval). This can make consumer lag appear inflated.
- **Abort on failure**: if a transaction was open when the job crashed, Kafka marks those offsets as aborted on restart.

For most use cases, 1–5 minute checkpoint intervals balance recovery granularity against overhead.

## Further Reading

This post builds on the standalone deep-dive [How Flink's Exactly-Once Semantics Actually Work](/blog/flink-exactly-once), which covers the Chandy-Lamport algorithm and two-phase commit in more detail with worked examples.

## Key Takeaways

- Flink injects **barriers** into streams to take distributed snapshots without stopping the world
- On failure, Flink restores operator state from the last checkpoint and replays from source offsets
- **Two-phase commit** extends exactly-once guarantees to transactional sinks like Kafka
- **Savepoints** are manually-triggered snapshots for operational use: upgrades, rescaling, migration
- Tune checkpoint interval based on recovery time requirements vs. overhead tolerance

Next: Performance & Production — backpressure, parallelism tuning, and making Flink operationally reliable.
