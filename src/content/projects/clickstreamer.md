---
title: "Clickstreamer — Real-time Clickstream Pipeline"
description: "End-to-end clickstream analytics pipeline using Kafka, Apache Flink, ClickHouse, and Grafana with a full Docker Compose setup."
date: 2024-08-07
tags: ["Kafka", "Apache Flink", "ClickHouse", "Grafana", "Docker"]
link: "https://github.com/ifkarsyah/clickstreamer"
image: ""
featured: false
---

## Overview

**Clickstreamer** is a self-contained demo of a real-time clickstream analytics stack. Pageview events are generated and ingested via Kafka (using the Confluent Datagen connector), processed by Apache Flink, stored in ClickHouse for fast OLAP queries, and visualized in Grafana — all wired together with Docker Compose.

## Architecture

```
[Confluent Datagen] → Kafka → [Flink Jobs] → ClickHouse → Grafana
```

## Features

- **Event simulation** — Confluent Datagen connector produces realistic pageview events into Kafka topics
- **Stream processing** — Flink consumes Kafka topics, applies windowed aggregations, and sinks to ClickHouse
- **Fast analytics** — ClickHouse columnar storage enables sub-second query response on millions of rows
- **Live dashboards** — Grafana dashboards show real-time page traffic, top pages, and session metrics
- **One-command setup** — Full stack runs with `docker compose up`

## Tech Stack

- **Apache Kafka** + Confluent Datagen — event streaming and source simulation
- **Apache Flink** — stateful stream processing
- **ClickHouse** — columnar OLAP database
- **Grafana** — real-time visualization
- **Docker Compose** — local orchestration
