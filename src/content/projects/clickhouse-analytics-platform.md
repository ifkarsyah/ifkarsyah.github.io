---
title: "ClickHouse Analytics Platform"
description: "A multi-tenant OLAP analytics platform on ClickHouse, serving sub-second queries on billions of rows for product and business dashboards."
date: 2023-05-20
tags: ["ClickHouse", "Python", "SQL", "Kubernetes"]
link: "https://github.com/ifkarsyah/clickhouse-platform"
image: ""
featured: false
---

## Overview

A self-managed ClickHouse cluster deployed on Kubernetes, purpose-built for product analytics workloads. Replaced a slow PostgreSQL-based reporting setup that could not scale beyond millions of rows.

## Features

- **Multi-tenant isolation** – Row-level policies and separate databases per team
- **Materialized views** – Pre-aggregated rollups for common dashboard queries
- **ReplicatedMergeTree** – 3-replica setup for fault tolerance and zero-downtime maintenance
- **Schema management** – Python CLI for applying migrations across shards safely
- **Query governance** – Per-user resource quotas and query complexity limits

## Optimizations Applied

```sql
-- Partition by date, order by high-cardinality query dimensions
CREATE TABLE events (
    date        Date,
    user_id     UInt64,
    event_type  LowCardinality(String),
    properties  Map(String, String)
) ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/events', '{replica}')
PARTITION BY toYYYYMM(date)
ORDER BY (event_type, user_id, date);
```

## Results

- P99 dashboard query latency: under 500ms on 10B+ rows
- Storage cost reduced 70% vs. PostgreSQL via native columnar compression
- Onboarded 5 product teams as self-service analytics consumers
