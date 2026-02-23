---
title: "Kafka Series, Part 0: Overview"
description: "What is Apache Kafka, what problem does it solve, and when should you use it? A roadmap for the series."
pubDate: 2024-04-07
author: "ifkarsyah"
domain: "Streaming"
stack: ["Kafka"]
image:
  src: ./kafka-series.png
  alt: "Apache Kafka Overview"
---

## The Problem Kafka Solves

In a growing data platform, you eventually hit a coupling problem. Service A needs to send data to Service B, C, and D. Service B needs data from A and E. Every producer knows every consumer. When you add a new consumer, you update every producer. When a consumer is slow, it blocks producers. When a consumer is down, data is lost.

This is point-to-point integration, and it does not scale.

**Apache Kafka** solves this with a different model: producers write data to Kafka, and consumers read from Kafka independently. Producers and consumers never talk to each other directly. Kafka acts as a durable, ordered, high-throughput log that decouples the two sides completely.

## What Kafka Is (and Isn't)

Kafka is often described as a **distributed event streaming platform**. More precisely, it is a distributed, partitioned, replicated commit log. Every record written to Kafka is appended to a log, assigned an offset, and retained for a configurable period — regardless of whether anyone has read it.

This is different from a traditional message queue:

| | Message Queue (e.g. RabbitMQ) | Kafka |
|---|---|---|
| Data model | Messages delivered and deleted | Immutable log, retained by time |
| Consumer model | Push (broker pushes to consumer) | Pull (consumer reads at its own pace) |
| Replay | Not supported | Yes — rewind offset to re-read |
| Scale | Thousands of msg/s | Millions of msg/s per broker |
| Consumer independence | One consumer per message | Many independent consumer groups |

Use a message queue when you need simple task dispatching. Use Kafka when you need **high-throughput event streaming, replay, or decoupling at scale**.

## Core Architecture

A Kafka cluster consists of:

**Brokers** — the servers that store and serve data. A cluster typically has 3–9 brokers for production redundancy.

**Topics** — the logical unit you publish to and consume from. A topic is split into one or more **partitions**, each of which is an ordered, immutable log on disk.

**Producers** — clients that write records to topics.

**Consumers** — clients that read records from topics. Consumers track their own position (offset) and read at their own pace.

**ZooKeeper / KRaft** — historically, Kafka relied on ZooKeeper for cluster coordination and metadata. Since Kafka 3.x, the **KRaft** mode (Kafka Raft) eliminates ZooKeeper, with Kafka managing its own metadata internally. New deployments should use KRaft.

```
Producers → [ Broker 1 | Broker 2 | Broker 3 ] → Consumers
                        ↕
              [ Topic: events, 3 partitions ]
              Partition 0: [msg0] [msg1] [msg4]
              Partition 1: [msg2] [msg5]
              Partition 2: [msg3] [msg6]
```

## When to Use Kafka

Kafka is the right choice when you need:

- **High throughput**: millions of events per second across multiple producers and consumers
- **Durability**: events are retained on disk and replicated across brokers
- **Replay**: consumers can re-read past events (for backfill, debugging, new service onboarding)
- **Fan-out**: multiple independent consumer groups read the same topic without interfering
- **Decoupling**: producers and consumers evolve independently

Kafka is overkill for simple task queues, low-volume webhooks, or request/response patterns. For those, a simpler queue (RabbitMQ, SQS) or HTTP is a better fit.

## Series Roadmap

This series builds up from the fundamentals to production-grade Kafka usage:

- **Part 1 — Topics, Partitions & Offsets**: The core data model — how Kafka stores data and how consumers track their position
- **Part 2 — Producers**: Writing to Kafka reliably — batching, compression, delivery guarantees
- **Part 3 — Consumers & Consumer Groups**: Reading from Kafka at scale — group coordination, offset commits, rebalancing
- **Part 4 — Reliability & Operations**: Replication, durability guarantees, and operational concerns
- **Part 5 — Kafka Connect**: Moving data in and out of Kafka without writing code
- **Part 6 — Kafka Streams**: Stream processing natively inside Kafka

## Key Takeaways

- Kafka is a **durable, partitioned, replicated commit log** — not a traditional message queue
- Producers and consumers are **fully decoupled** — consumers read at their own pace
- Kafka retains data on disk and supports **replay** — consumers can re-read past events
- Use Kafka for high-throughput streaming, fan-out, and decoupling; use simpler queues for task dispatch

**Next:** [Topics, Partitions & Offsets](/blog/kafka-series-1-topics-partitions)
