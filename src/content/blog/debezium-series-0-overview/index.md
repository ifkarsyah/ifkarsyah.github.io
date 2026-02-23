---
title: "Debezium Series, Part 0: Overview"
description: "A practical guide to Change Data Capture with Debezium — from WAL internals to Delta Lake and Iceberg sinks. What you'll learn and why CDC matters."
pubDate: 2026-02-23
author: "ifkarsyah"
domain: "Streaming"
stack: ["Debezium", "Kafka", "PostgreSQL"]
image:
  src: ./debezium-series.png
  alt: "Debezium CDC Series Overview"
---

Every database tells a story. Not just the current state of your tables — but every insert, update, and delete that ever happened. Most systems throw that story away. **Change Data Capture (CDC)** keeps it.

Debezium is an open-source CDC platform built on Kafka Connect. It reads the low-level transaction logs of your databases — PostgreSQL's WAL, MySQL's binlog — and turns every database change into a structured event stream. Those events can feed data lakes, search indexes, caches, microservices, or analytics systems, all in near real-time.

This series is a practical guide to Debezium from first principles through production operation.

## Why CDC?

The traditional alternative to CDC is **polling**: run a query like `SELECT * FROM orders WHERE updated_at > :last_run` every few minutes. Polling is simple but has real limitations:

- **Deletes are invisible** — a deleted row leaves no trace for a poll to find
- **Latency** — minutes of lag by default, not seconds
- **Database load** — repeated full or partial scans on production tables
- **No before-image** — you see the new value, never what changed

Log-based CDC solves all of these. By reading the transaction log directly, Debezium captures inserts, updates, and deletes — including the before and after state — with sub-second latency and zero impact on your primary workload.

## The Architecture

```
┌─────────────┐    WAL/binlog    ┌──────────────────┐    Kafka    ┌─────────────┐
│  PostgreSQL │ ──────────────► │ Debezium Connector│ ──────────► │ Kafka Topic │
│   MySQL     │                 │ (Kafka Connect)   │             │             │
└─────────────┘                 └──────────────────┘             └──────┬──────┘
                                                                         │
                              ┌──────────────────────────────────────────┤
                              │                  │                        │
                       ┌──────▼──────┐   ┌───────▼──────┐   ┌───────────▼────┐
                       │ Delta Lake  │   │    Iceberg   │   │  Elasticsearch │
                       │  (Sink)     │   │   (Sink)     │   │    (Sink)      │
                       └─────────────┘   └──────────────┘   └────────────────┘
```

Debezium runs inside **Kafka Connect** — a framework for scalable, fault-tolerant data pipelines. The connector reads your database log, translates changes into JSON or Avro events, and publishes them to Kafka topics. From there, sink connectors or stream processors route data to targets.

## What We'll Cover

### Part 1: How CDC Works
We go under the hood: what a Write-Ahead Log is, how PostgreSQL's logical replication works, how Debezium reads it, and what at-least-once delivery means in practice.

### Part 2: Setting Up Debezium
A hands-on Docker Compose setup. You'll run PostgreSQL, Kafka, Kafka Connect, and the Debezium connector — and see your first change event in under 10 minutes.

### Part 3: Change Event Anatomy
Every Debezium event has a standard envelope: `before`, `after`, `op`, `source`, `ts_ms`. We dissect each field, explain tombstone events, and show how the schema is encoded.

### Part 4: Source Connectors — PostgreSQL & MySQL
Deep dive into the two most common sources. PostgreSQL uses `pgoutput` (logical replication); MySQL uses the binlog. We compare their behaviors, config options, and gotchas.

### Part 5: Sink Connectors — Delta Lake & Iceberg
How to land CDC events into open table formats. Handling upserts and deletes, MERGE INTO semantics, partition strategies, and schema evolution in a lakehouse.

### Part 6: Handling Schema Changes
What happens when someone adds a column or renames a field? We cover DDL propagation, schema registry integration, and how to handle breaking vs. non-breaking changes without downtime.

### Part 7: Snapshotting
Before Debezium can stream changes, it must capture existing data. We cover all snapshot modes — `initial`, `never`, `always`, `when_needed` — and the isolation guarantees each provides.

### Part 8: Transforms & Routing
Single Message Transforms (SMTs) let you reshape, filter, and route events before they reach Kafka. We cover the built-in transforms, topic routing, field masking, and when to reach for a stream processor instead.

### Part 9: Production Concerns
Offset management, failure recovery, monitoring connector lag, handling rebalances, and the operational patterns that keep a CDC pipeline healthy under load.

## Prerequisites

- Familiarity with PostgreSQL or MySQL (basic administration)
- Basic Kafka concepts (topics, producers, consumers)
- Docker and Docker Compose installed locally

You do not need to know Kafka Connect internals — we build up from scratch.

**Next:** [How CDC Works](/blog/debezium-series-1-how-cdc-works)
