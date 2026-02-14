---
title: "Kafka Series, Part 3: Consumers & Consumer Groups"
description: "Reading from Kafka at scale — consumer groups, partition assignment, offset commits, and handling rebalances."
pubDate: 2024-04-28
author: "ifkarsyah"
tags: ["Kafka", "Data Engineering", "Streaming"]
image:
  src: ./kafka-series.png
  alt: "Apache Kafka Consumers and Consumer Groups"
---

## The Pull Model

Kafka consumers **pull** data from brokers — they decide when to read and how fast. This is the opposite of a push-based message queue where the broker delivers messages to consumers.

Pull has a key advantage: a slow consumer does not slow down producers or other consumers. The consumer simply reads at its own pace, and the broker retains data until the consumer catches up (within the retention window).

## Basic Consumer Setup

```python
from kafka import KafkaConsumer
import json

consumer = KafkaConsumer(
    "user-events",
    bootstrap_servers="kafka:9092",
    group_id="analytics-service",
    auto_offset_reset="latest",
    value_deserializer=lambda v: json.loads(v.decode("utf-8")),
)

for message in consumer:
    print(f"Partition {message.partition}, Offset {message.offset}")
    print(message.value)
```

`group_id` is the consumer group identifier. Every consumer that shares the same `group_id` participates in the same group and cooperates to read the topic.

## Consumer Groups and Partition Assignment

A **consumer group** is the mechanism for scalable, parallel consumption. Kafka assigns each partition to exactly one consumer within a group. If a topic has 6 partitions and a group has 3 consumers, each consumer gets 2 partitions.

```
Topic: user-events (6 partitions)

Consumer Group: analytics-service
  Consumer A → Partition 0, Partition 1
  Consumer B → Partition 2, Partition 3
  Consumer C → Partition 4, Partition 5
```

Rules:
- **One consumer per partition** (within a group) — the ceiling on parallelism
- **Multiple groups** can read the same topic independently — each group maintains its own offsets
- If you have **more consumers than partitions**, some consumers sit idle

Multiple independent services reading the same topic simply use different `group_id` values. They read at their own pace without interfering with each other.

## Rebalancing

When the group membership changes — a consumer joins, leaves, or crashes — Kafka triggers a **rebalance** to redistribute partitions. During a rebalance, all consumers in the group stop processing while the group coordinator reassigns partitions.

Rebalances are the main source of consumer latency spikes. Two strategies minimize their impact:

**Cooperative sticky rebalancing** (Kafka 2.4+): instead of revoking all partitions and reassigning from scratch, only partitions that need to move are reassigned. Most consumers keep their current partitions.

```python
consumer = KafkaConsumer(
    "user-events",
    bootstrap_servers="kafka:9092",
    group_id="analytics-service",
    partition_assignment_strategy=["cooperative-sticky"],
)
```

**Static group membership**: assign a `group.instance.id` to each consumer. On restart, the consumer rejoins with the same identity and reclaims its partitions without triggering a rebalance.

```python
consumer = KafkaConsumer(
    "user-events",
    bootstrap_servers="kafka:9092",
    group_id="analytics-service",
    group_instance_id="consumer-node-1",  # static identity
    session_timeout_ms=60000,             # longer timeout for slow restarts
)
```

## Offset Commits: Auto vs Manual

Committing an offset tells Kafka "I have processed up to this point." On restart, the consumer resumes from the last committed offset.

### Auto-commit (default)

```python
consumer = KafkaConsumer(
    "user-events",
    bootstrap_servers="kafka:9092",
    group_id="my-group",
    enable_auto_commit=True,
    auto_commit_interval_ms=5000,  # commit every 5 seconds
)
```

Auto-commit is simple but risky: if the consumer crashes between the auto-commit interval, records received but not yet committed will be re-read — **at-least-once** delivery. If the consumer crashes *after* the commit but before processing finishes, records are lost — **at-most-once** in the worst case.

### Manual commit

```python
consumer = KafkaConsumer(
    "user-events",
    bootstrap_servers="kafka:9092",
    group_id="my-group",
    enable_auto_commit=False,
)

for message in consumer:
    process(message.value)
    # Commit only after processing succeeds
    consumer.commit()
```

Manual commit gives you control: commit only after you have successfully processed the record. This ensures **at-least-once** delivery — you may reprocess on restart, but you will never silently lose a record.

For **exactly-once**, you need to make processing and offset commit atomic — typically by writing the offset into the same database transaction as the processed result (transactional outbox pattern), or by using Kafka Streams' built-in exactly-once support.

## Poll Loop and Heartbeating

The consumer must call `poll()` regularly to:
1. Fetch new records from the broker
2. Send **heartbeats** to the group coordinator to signal it is alive

If a consumer fails to heartbeat within `session.timeout.ms`, the coordinator declares it dead and triggers a rebalance. If `poll()` is not called within `max.poll.interval.ms`, the consumer is also evicted.

```python
consumer = KafkaConsumer(
    "user-events",
    bootstrap_servers="kafka:9092",
    group_id="my-group",
    session_timeout_ms=30000,       # consumer declared dead after 30s without heartbeat
    heartbeat_interval_ms=10000,    # heartbeat every 10s
    max_poll_interval_ms=300000,    # evicted if poll() not called within 5 minutes
    max_poll_records=500,           # records returned per poll call
)

while True:
    records = consumer.poll(timeout_ms=1000)
    for partition, messages in records.items():
        for msg in messages:
            process(msg)
    consumer.commit()
```

If your processing per batch is slow, increase `max_poll_interval_ms` rather than making batches smaller — this avoids spurious rebalances.

## Key Takeaways

- Kafka uses a **pull model** — consumers read at their own pace, brokers do not push
- **Consumer groups** distribute partitions across consumers; each partition goes to exactly one consumer per group
- **Multiple groups** read the same topic independently with separate offsets
- **Rebalances** redistribute partitions when group membership changes — use cooperative-sticky or static membership to minimize disruption
- **Manual offset commits** give you at-least-once delivery; auto-commit is simpler but less precise
- Keep `poll()` calls frequent to avoid session timeouts and unwanted rebalances

Next: Reliability & Operations — replication, durability guarantees, and keeping Kafka healthy in production.
