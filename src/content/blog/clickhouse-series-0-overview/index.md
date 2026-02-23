---
title: "ClickHouse Series, Part 0: Overview"
description: "What is ClickHouse, how does columnar storage work, and when should you use it? A roadmap for the series."
pubDate: 2024-06-02
author: "ifkarsyah"
domain: "Database"
stack: ["ClickHouse"]
image:
  src: ./clickhouse-series.png
  alt: "ClickHouse Overview"
---

## The OLAP Problem

Most databases are designed for transactional workloads: insert a row, update a row, fetch a row by primary key. These are OLTP (Online Transaction Processing) patterns — point lookups, small reads and writes, high concurrency.

Analytical workloads are different. A dashboard query might read 500 million events, filter by date range, group by country, and compute a unique user count. A row-oriented database like Postgres will read every column of every matching row, even if the query only needs two columns out of twenty.

**ClickHouse** is built specifically for this: OLAP (Online Analytical Processing) at scale. It stores data column by column, compresses aggressively, and scans billions of rows per second on commodity hardware.

## Columnar Storage

In a row-oriented store, a row's columns are stored contiguously on disk:

```
Row 1: [2024-01-01] [user-42] [click] [US]
Row 2: [2024-01-01] [user-99] [purchase] [DE]
Row 3: [2024-01-02] [user-42] [click] [US]
```

To compute `count(*) WHERE country = 'US'`, you read every row and extract the `country` column from each.

In a columnar store, each column is stored separately:

```
date:    [2024-01-01] [2024-01-01] [2024-01-02]
user_id: [user-42]   [user-99]    [user-42]
event:   [click]     [purchase]   [click]
country: [US]        [DE]         [US]
```

To answer the same query, you only read the `country` column — skipping the other three entirely. For wide tables with many columns, this is a dramatic reduction in I/O.

Columnar data also compresses far better: a column of repeated country codes compresses to almost nothing. ClickHouse typically achieves 10–20x compression ratios on real event data.

## Architecture

ClickHouse runs as a single binary. For production, you deploy a cluster of nodes:

**Shards** — horizontal partitions of your data. A table with 2 shards distributes rows across 2 nodes, doubling write and read throughput. Each shard handles a subset of the data.

**Replicas** — copies of each shard for fault tolerance. A 2-shard, 2-replica cluster has 4 nodes total: 2 shards × 2 replicas each.

**ZooKeeper / ClickHouse Keeper** — coordinates replication metadata and distributed DDL. ClickHouse Keeper is the modern replacement for ZooKeeper, written in C++ and bundled with ClickHouse.

```
Cluster: 2 shards × 2 replicas

Shard 1: [Node A (leader)] ↔ [Node B (replica)]
Shard 2: [Node C (leader)] ↔ [Node D (replica)]
```

For small deployments, a single node handles hundreds of billions of rows comfortably. Sharding is only needed when a single node's disk or throughput is insufficient.

## ClickHouse vs the Alternatives

| | ClickHouse | BigQuery / Redshift | Postgres | Druid |
|---|---|---|---|---|
| Model | Columnar, on-premise or self-hosted cloud | Columnar, managed cloud | Row-oriented | Columnar, pre-aggregated |
| Latency | Sub-second on billions of rows | Seconds to minutes | Milliseconds (small data) | Sub-second (pre-agg only) |
| Cost | Self-hosted = compute + disk | Per-query/scan pricing | Cheap for small data | Complex to operate |
| SQL | Full SQL | Full SQL | Full SQL | Limited SQL |
| Real-time ingestion | Yes (MergeTree) | Limited | Yes | Yes |

Use ClickHouse when you need **sub-second queries on large datasets**, want to self-host, and need real-time ingestion alongside analytical queries.

## When to Use ClickHouse

ClickHouse is the right choice for:
- **Product analytics** — event funnels, retention, DAU/MAU on billions of events
- **Log analytics** — searching and aggregating application or infrastructure logs
- **Time-series analytics** — metrics, monitoring data, financial ticks
- **Ad tech** — impression/click counting, attribution at high ingest rates
- **Real-time dashboards** — queries need to return in under a second

ClickHouse is a poor fit for:
- Transactional workloads (use Postgres, MySQL)
- Point lookups by primary key (use a key-value store)
- Frequent updates to individual rows (ClickHouse is append-optimized)
- Joins across many large tables (ClickHouse joins are less mature than Postgres)

## Series Roadmap

- **Part 1 — MergeTree Engines**: The engine family at the heart of ClickHouse — and when to use each variant
- **Part 2 — Schema Design**: Choosing the right data types, ORDER BY key, partitioning strategy, and TTL
- **Part 3 — Data Ingestion**: Getting data into ClickHouse efficiently — batch inserts, async inserts, Kafka, and S3
- **Part 4 — Internals**: How ClickHouse actually stores and merges data — parts, granules, and indexes
- **Part 5 — Query Optimization**: Making queries faster — profiling, projections, and design patterns
- **Part 6 — Materialized Views & Operations**: Pre-aggregation patterns, replication, sharding, and monitoring

## Key Takeaways

- ClickHouse is a **columnar OLAP database** — it reads only the columns a query needs and compresses aggressively
- It is designed for **analytical queries on large datasets**, not transactional point lookups
- A cluster is organized as **shards** (horizontal partitions) and **replicas** (copies for fault tolerance)
- Use ClickHouse for product analytics, log analytics, time-series, and real-time dashboards

**Next:** [MergeTree Engines — the storage engine family that makes ClickHouse work, and which variant to reach for](/blog/clickhouse-series-1-merge-tree)
