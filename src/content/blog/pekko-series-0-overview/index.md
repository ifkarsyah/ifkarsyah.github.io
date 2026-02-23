---
title: "Apache Pekko Series, Part 0: Overview"
description: "A practical guide to building concurrent, distributed, and resilient systems with Apache Pekko — the open-source fork of Akka. What you'll learn and why Pekko matters."
pubDate: 2026-02-23
author: "ifkarsyah"
domain: "Streaming"
stack: ["Pekko", "Scala"]
image:
  src: ./pekko-series.png
  alt: "Apache Pekko Series Overview"
---

Threads are a lie. Not literally — the OS does schedule them — but the mental model they impose is wrong. We write sequential code, add locks to protect shared state, and then wonder why production is full of deadlocks, race conditions, and cascading failures. There is a better way.

**Apache Pekko** is a toolkit for building highly concurrent, distributed, and resilient message-driven applications on the JVM. It replaces the shared-mutable-state model with the **actor model**: isolated units of computation that communicate only by passing immutable messages.

## What is Apache Pekko?

Pekko is a direct fork of Akka 2.6.x. In September 2022, Lightbend relicensed Akka under the Business Source License (BSL) — a non-open-source license that prohibits commercial use without a paid subscription. The Apache Software Foundation forked Akka at 2.6.20 and donated it to the Apache incubator. Apache Pekko 1.0 graduated to a top-level Apache project in 2023, preserving the original Apache 2.0 license.

If you use Akka, Pekko is a near-identical drop-in replacement. If you are starting fresh, Pekko is the open-source choice.

## The Actor Model

At the core of Pekko is the actor model, first described by Carl Hewitt in 1973. The rules are simple:

- **Everything is an actor.** An actor is the fundamental unit of computation.
- **Actors communicate only by messages.** No shared memory, no direct method calls.
- **Each actor processes one message at a time.** No internal concurrency, no need for locks.
- **Actors can create child actors.** Forming a supervision hierarchy.

```
┌──────────────────────────────────────────────┐
│                  ActorSystem                 │
│                                              │
│   ┌─────────────┐     msg     ┌────────────┐ │
│   │  Actor A    │ ──────────► │  Actor B   │ │
│   │  (mailbox)  │             │  (mailbox) │ │
│   └─────────────┘             └────────────┘ │
│         │                                    │
│    creates                                   │
│         ▼                                    │
│   ┌─────────────┐                            │
│   │  Actor C    │  (child of A)              │
│   │  (mailbox)  │                            │
│   └─────────────┘                            │
└──────────────────────────────────────────────┘
```

This model naturally handles concurrency (no shared state), distribution (actors can live on different machines), and fault tolerance (parent actors supervise and recover children).

## Pekko Modules

Pekko is modular. You start with the core actor system and add capabilities as needed:

| Module | Purpose |
|--------|---------|
| **pekko-actor-typed** | Type-safe actors with `Behavior[T]` |
| **pekko-persistence-typed** | Event sourcing — actors that journal their state |
| **pekko-stream** | Reactive stream processing with backpressure |
| **pekko-http** | HTTP server and client built on streams |
| **pekko-grpc** | gRPC server and client via protobuf |
| **pekko-cluster** | Multi-node actor systems with gossip and sharding |
| **pekko-projection** | CQRS read-side projections from event journals |
| **pekko-connectors-kafka** | Akka Streams source/sink for Apache Kafka |

## Architecture Overview

```
                        ┌───────────────────────────┐
                        │       pekko-cluster        │
                        │  (node discovery, sharding)│
                        └────────────┬──────────────┘
                                     │
              ┌──────────────────────┼───────────────────────┐
              │                      │                       │
   ┌──────────▼──────┐  ┌────────────▼──────┐  ┌────────────▼──────┐
   │  pekko-http     │  │pekko-persistence  │  │  pekko-stream     │
   │  (REST / WS)    │  │  (event sourcing) │  │  (backpressure)   │
   └──────────┬──────┘  └────────────┬──────┘  └────────────┬──────┘
              │                      │                       │
              └──────────────────────┼───────────────────────┘
                                     │
                        ┌────────────▼──────────────┐
                        │    pekko-actor-typed       │
                        │   (core actor system)      │
                        └───────────────────────────┘
```

## What We'll Cover

### Part 1: The Actor Model
What an actor is, how message passing works, why this model solves concurrency, and how to create your first `ActorSystem` in Scala.

### Part 2: Actor Lifecycle & Supervision
How actors start, stop, and fail. The supervision hierarchy, strategies (`restart`, `stop`, `escalate`), and how Pekko makes your system self-healing.

### Part 3: Persistence & Event Sourcing
`EventSourcedBehavior` — actors that write every state change to a journal. Recovery on restart, snapshots for fast startup, and the event-sourcing mental model.

### Part 4: Streams & Reactive Processing
`Source`, `Flow`, and `Sink`. Backpressure by design. Building data pipelines that handle variable load without dropping messages or crashing.

### Part 5: HTTP with Pekko
Building REST APIs with the routing DSL. Streaming request and response bodies. Integrating HTTP endpoints with your actor system.

### Part 6: gRPC with Pekko
Protocol Buffers, generated server/client stubs, bidirectional streaming. When to use gRPC over HTTP and how to run both side-by-side.

### Part 7: Clustering & Distributed Actors
Running Pekko across multiple JVMs. Cluster membership, gossip protocol, cluster sharding, and distributed pub-sub.

### Part 8: CQRS & Projections
Separating write models (actors) from read models (projections). `pekko-projection` — consuming the event journal to build materialized views.

### Part 9: Production Best Practices
Kafka connectors, distributed tracing with OpenTelemetry, health checks, tuning dispatcher threads, Kubernetes deployment, and migrating from Akka.

## Prerequisites

- Familiarity with Scala (case classes, pattern matching, futures)
- Basic JVM knowledge (heap, threads)
- Docker and Docker Compose installed locally

You do not need prior Akka or actor-model experience — we start from the fundamentals.

**Next:** [The Actor Model](/blog/pekko-series-1-actor-model)
