---
title: "Lakehouse Platform"
description: "A self-service data lakehouse built on Databricks and Delta Lake, unifying batch and streaming workloads with a single storage layer."
date: 2023-09-10
tags: ["Spark", "Databricks", "Delta Lake", "Python", "Airflow"]
link: "https://github.com/ifkarsyah/lakehouse-platform"
image: ""
featured: true
---

## Overview

An internal data platform that provides a unified lakehouse architecture using Delta Lake on cloud object storage. Teams can run both batch ETL and low-latency queries on the same data, eliminating the traditional Lambda architecture complexity.

## Architecture

Uses the medallion pattern — raw data lands in the Bronze layer, gets cleaned and deduplicated in Silver, and aggregated business-level data lives in Gold.

```
[Sources] → Bronze (raw) → Silver (clean) → Gold (aggregated)
                  ↑ Spark Structured Streaming / Batch
```

## Features

- **ACID transactions** – Delta Lake ensures no partial writes or read inconsistencies
- **Time travel** – Query historical snapshots of any table for debugging and auditing
- **Schema enforcement** – Automatic schema validation on write with evolution support
- **Unified batch + streaming** – Same Spark jobs run in both batch and streaming modes
- **Orchestration** – Airflow DAGs manage job scheduling, retries, and SLA alerting

## Impact

- Eliminated 3 separate data silos across teams
- Reduced data pipeline development time by 40% via reusable Spark libraries
- Enabled ML teams to access clean, versioned feature data without custom ETL work
