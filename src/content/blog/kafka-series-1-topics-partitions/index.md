---
title: "Kafka Series, Part 1: Topics, Partitions & Offsets"
description: "The core data model behind Kafka — how topics are structured, why partitions matter, and how offsets track consumer position."
pubDate: 2024-04-14
author: "ifkarsyah"
domain: "Streaming"
stack: ["Kafka"]
image:
  src: ./kafka-series.png
  alt: "Apache Kafka Topics Partitions Offsets"
---

## The Commit Log

At its core, Kafka is a **commit log**: an append-only, ordered sequence of records on disk. Every record has a position — its **offset** — that never changes. Unlike a message queue that deletes messages after delivery, Kafka retains records for a configurable retention period (default: 7 days). Consumers read from the log at their own pace and track their own position.

This model is deceptively simple and is the source of most of Kafka's power: durability, replay, and consumer independence all follow from it.

## Topics

A **topic** is a named, logical channel for a stream of records. You produce to a topic and consume from a topic. Topics are roughly analogous to database tables or S3 prefixes — they group related data.

```bash
# Create a topic with 3 partitions and replication factor 3
kafka-topics.sh --create \
  --topic user-events \
  --partitions 3 \
  --replication-factor 3 \
  --bootstrap-server kafka:9092
```

## Partitions

A topic is divided into one or more **partitions**. Each partition is an independent ordered log. Partitions are the unit of:

- **Parallelism**: different partitions can be written and read by different brokers and consumers simultaneously
- **Ordering**: within a partition, records are strictly ordered by offset; across partitions, there is no ordering guarantee
- **Distribution**: partitions are spread across brokers, balancing load

```
Topic: user-events (3 partitions)

Partition 0: [offset 0] [offset 1] [offset 2] ...
Partition 1: [offset 0] [offset 1] [offset 2] ...
Partition 2: [offset 0] [offset 1] [offset 2] ...
```

### Choosing Partition Count

More partitions = more parallelism, but also more overhead (file handles, leader elections, replication). A practical starting point:

- Match partition count to the maximum number of consumers you expect in a consumer group (one consumer per partition is the ceiling)
- For high-throughput topics, start with 6–12 partitions and scale up
- Partition count can be increased later, but **decreasing is not supported** — plan ahead

### Partition Assignment (Producer Side)

When a producer sends a record with a **key**, Kafka assigns it to a partition deterministically using `hash(key) % num_partitions`. Records with the same key always land on the same partition — and therefore arrive in order at the consumer.

Records without a key are distributed round-robin (or using the sticky partitioner for better batching).

```python
# Records with the same user_id always go to the same partition
producer.send("user-events", key=b"user-42", value=b"clicked")
producer.send("user-events", key=b"user-42", value=b"purchased")
# These two records land on the same partition, in order
```

## Offsets

An **offset** is the position of a record within a partition. Offsets are assigned sequentially (0, 1, 2, …) and are immutable — once written, a record's offset never changes.

Consumers use offsets to track their progress:

```
Partition 0:  [0] [1] [2] [3] [4] [5]
                               ↑
                        consumer is here (committed offset: 3)
                        next record to read: offset 4
```

Offsets are stored in a special Kafka topic called `__consumer_offsets`. When a consumer (or consumer group) commits its offset, it writes to this topic. On restart, the consumer reads its last committed offset and resumes from there.

### Offset Reset Policy

When a consumer group has no committed offset (first start, or offset expired), `auto.offset.reset` controls where to start:

- `earliest` — read from the beginning of the partition (good for backfill)
- `latest` — read only new records written after the consumer started (default for most apps)
- `none` — throw an exception if no offset exists

## Retention

Kafka retains records based on time or size:

```properties
# Time-based retention (default: 7 days)
log.retention.hours=168

# Size-based retention (delete oldest segments when topic exceeds 10 GB)
log.retention.bytes=10737418240

# Compact: keep only the latest record per key (useful for changelogs)
log.cleanup.policy=compact
```

**Log compaction** is special: instead of deleting records by age, Kafka keeps the latest record for each key indefinitely. This turns a Kafka topic into a key-value store — useful for materializing the current state of a changelog stream.

## Replicas and Leaders

Each partition has one **leader** replica and zero or more **follower** replicas. Producers always write to the leader; followers replicate asynchronously. If the leader broker fails, a follower is promoted.

The set of in-sync replicas (**ISR**) tracks which followers are caught up with the leader. This is central to durability guarantees — covered in Part 4.

## Key Takeaways

- A topic is divided into **partitions**, each an independent ordered log
- Records are assigned offsets that never change — enabling replay and consumer independence
- **Keys** determine partition assignment — same key always lands on the same partition, preserving order
- **Offsets** are how consumers track their position; stored in `__consumer_offsets`
- Set **retention** by time or size; use **log compaction** for changelog-style topics

**Next:** [Producers](/blog/kafka-series-2-producers)
