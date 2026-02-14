---
title: "Kafka Series, Part 4: Reliability & Operations"
description: "Replication, in-sync replicas, durability guarantees, and operational concerns for running Kafka in production."
pubDate: 2024-05-05
author: "ifkarsyah"
tags: ["Kafka", "Data Engineering", "Streaming"]
image:
  src: ./kafka-series.png
  alt: "Apache Kafka Reliability and Operations"
---

## What Can Go Wrong

In production, brokers crash, network partitions happen, disks fill up. Kafka's reliability story is built on one mechanism: **replication**. Every partition can have multiple copies across brokers. When one broker fails, another takes over. The details of how this works — and how to configure it correctly — determine whether you lose data or not.

## Replication

Each partition has one **leader** and zero or more **followers**. Producers always write to the leader. Followers replicate the leader's log by fetching new records continuously.

```
Topic: user-events, Partition 0 (replication-factor: 3)

Leader:   Broker 1  ← producers write here
Follower: Broker 2  ← replicates from Broker 1
Follower: Broker 3  ← replicates from Broker 1

Consumers read from the leader (or followers with replica.selector.class)
```

A **replication factor of 3** is the standard recommendation for production: the cluster tolerates losing one broker without any data loss or unavailability. With replication factor 2, losing one broker causes unavailability (not enough replicas for `min.insync.replicas=2`).

## In-Sync Replicas (ISR)

Not all followers stay perfectly caught up. The **ISR** (in-sync replicas) is the set of replicas that are within `replica.lag.time.max.ms` of the leader. Replicas that fall behind (due to network issues or slow I/O) are removed from the ISR.

The ISR is critical for durability. When a producer uses `acks=all`, the broker waits for all **ISR members** to acknowledge the record before responding. If a follower is not in the ISR, it is not waited on — this prevents a slow replica from blocking producers indefinitely.

```properties
# broker config
replica.lag.time.max.ms=10000    # follower removed from ISR if 10s behind
min.insync.replicas=2            # minimum ISR size for acks=all writes to succeed
```

With `min.insync.replicas=2` and `replication.factor=3`:
- Normal operation: 3 ISR members, all writes succeed
- One broker fails: 2 ISR members, writes still succeed
- Two brokers fail: 1 ISR member, writes fail with `NotEnoughReplicasException` — protecting durability over availability

## Leader Election

When a leader broker fails, Kafka automatically elects a new leader from the ISR. Only ISR members are eligible — this ensures the new leader has all committed records.

If the ISR shrinks to zero (all replicas are behind), Kafka must choose between:
- **Wait for an ISR member** to recover (data safety, but unavailability)
- **Elect an out-of-sync replica** (availability, but potential data loss)

This is controlled by `unclean.leader.election.enable`:

```properties
# Default: false (safe — prefer data loss prevention over availability)
unclean.leader.election.enable=false
```

Leave this as `false` for any topic where data loss is unacceptable. Set to `true` only for topics where availability matters more than correctness (e.g., metrics, logs).

## Durability Configuration Checklist

For a durable production topic:

```properties
# Topic level
replication.factor=3
min.insync.replicas=2

# Broker level
unclean.leader.election.enable=false
log.flush.interval.messages=10000   # or rely on OS page cache (usually fine)

# Producer level (in your app)
acks=all
enable.idempotence=true
retries=2147483647
```

The combination of `acks=all`, `min.insync.replicas=2`, and `replication.factor=3` gives you the strongest durability guarantee Kafka offers.

## Monitoring Key Metrics

**Under-replicated partitions** — partitions where the ISR is smaller than the replication factor. Any non-zero value means a broker is behind or down.

```
kafka.server:type=ReplicaManager,name=UnderReplicatedPartitions
```

**Controller count** — exactly one broker is the controller at a time. If this is not 1, there is a problem.

**Consumer group lag** — the difference between the latest offset in a partition and the consumer's current offset. Rising lag means the consumer is falling behind.

```bash
# Check consumer group lag
kafka-consumer-groups.sh \
  --bootstrap-server kafka:9092 \
  --describe \
  --group analytics-service
```

**Request latency** — `RequestHandlerAvgIdlePercent` should be above 30%. If request handlers are consistently busy, the broker is under-provisioned.

## Topic Configuration for Operations

```bash
# Alter topic config without downtime
kafka-configs.sh --alter \
  --entity-type topics \
  --entity-name user-events \
  --add-config retention.ms=604800000 \
  --bootstrap-server kafka:9092

# Increase partition count (cannot decrease)
kafka-topics.sh --alter \
  --topic user-events \
  --partitions 12 \
  --bootstrap-server kafka:9092
```

## Disk and Retention Management

Kafka uses local disk for log segments. Monitor:
- **Disk usage per broker**: should stay below 70% to allow for log compaction and temporary spikes
- **Log segment count**: high segment counts slow down broker startup
- **Retention policy**: set `log.retention.hours` and `log.retention.bytes` per topic based on replay needs vs storage cost

For topics that need indefinite retention of the latest value per key, use **log compaction**:
```properties
cleanup.policy=compact
min.cleanable.dirty.ratio=0.5
```

## Key Takeaways

- Set `replication.factor=3` and `min.insync.replicas=2` for production durability
- The **ISR** tracks which replicas are in sync — `acks=all` waits for all ISR members
- Keep `unclean.leader.election.enable=false` to prevent data loss during leader failover
- Monitor **under-replicated partitions** and **consumer group lag** as primary health signals
- Partition count can be increased but never decreased — plan ahead

Next: Kafka Connect — moving data in and out of Kafka without writing custom producer/consumer code.
