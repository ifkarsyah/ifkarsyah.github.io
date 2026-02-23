---
title: "Real-time Ingestion Pipeline"
description: "A high-throughput streaming ingestion platform built with Apache Flink and Kafka, processing 500k+ events/sec into ClickHouse."
date: 2024-01-15
domain: "Streaming"
stack: ["Kafka", "Flink", "ClickHouse"]
link: "https://github.com/ifkarsyah/realtime-ingestion"
image: ""
featured: true
---

## Overview

A production-grade streaming data pipeline that ingests, transforms, and loads event data in real time. Built to replace a fragile batch-based system that caused multi-hour reporting delays.

## Architecture

Events flow from application services into Kafka topics. Apache Flink jobs consume these topics, apply transformations and late-event handling, and sink results into ClickHouse for low-latency OLAP queries.

```
[App Services] → Kafka → [Flink Jobs] → ClickHouse
                              ↓
                        [Dead Letter Queue]
```

## Features

- **Exactly-once semantics** – Flink checkpointing with Kafka offset tracking
- **Late event handling** – Configurable watermarking with side-output for late records
- **Schema evolution** – Avro schemas with a Schema Registry for forward/backward compatibility
- **Backpressure-aware** – Flink's credit-based flow control prevents consumer lag accumulation
- **Kubernetes-native** – Deployed via Flink Kubernetes Operator with auto-scaling

## Results

- Processes 500k+ events/second at peak load
- End-to-end latency under 3 seconds (event time to queryable in ClickHouse)
- Replaced a 4-hour nightly batch job with continuous real-time updates
