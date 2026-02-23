---
title: "Spark Series, Part 0: Overview"
description: "A high-level introduction to Apache Spark — what it is, why it exists, and where it fits in the modern data stack."
pubDate: 2024-01-07
author: "ifkarsyah"
domain: "Data Engineering"
stack: ["Spark"]
image:
  src: ./spark-series.png
  alt: "Apache Spark"
---

## What Is Apache Spark?

Apache Spark is an open-source, distributed computing engine designed for large-scale data processing. It was created at UC Berkeley's AMPLab in 2009 and donated to the Apache Software Foundation in 2013. Today it is the de facto standard for batch and streaming data processing at scale.

The core insight behind Spark is simple: keep data in memory across computation stages instead of writing intermediate results to disk. This makes it 10–100× faster than Hadoop MapReduce for most workloads.

## Why Spark, Not Hadoop MapReduce?

MapReduce was transformative but painful to use. Every job required two stages — map and reduce — and intermediate data was written to HDFS between every step. This meant complex pipelines required many sequential disk reads and writes.

Spark replaces the rigid map-reduce model with a general DAG (Directed Acyclic Graph) execution engine. You express your computation as a series of transformations, and Spark figures out how to execute them efficiently — often keeping intermediate data in memory entirely.

## The Spark Ecosystem

Spark is not just one tool. It is a platform with several components:

- **Spark Core** — the foundation: distributed task scheduling, memory management, fault tolerance
- **Spark SQL / DataFrames** — structured data processing with a SQL interface
- **Spark Streaming / Structured Streaming** — real-time stream processing
- **MLlib** — distributed machine learning
- **GraphX** — graph computation

This series will focus on Spark Core, Spark SQL, and Structured Streaming — the three components you will use in almost every data engineering project.

## Where Spark Fits

Spark is not a storage system. It does not store your data. It reads from and writes to external systems: HDFS, S3, GCS, Kafka, JDBC databases, Delta Lake, Iceberg, and others.

In a typical data platform:

```
Source (Kafka / S3 / DB)
        ↓
    Spark Job
        ↓
   Storage (Delta / Parquet / Warehouse)
        ↓
   Query Engine (Trino / BigQuery / Redshift)
```

Spark sits in the transformation layer. It is responsible for reading raw data, applying business logic, and writing clean, structured output.

## The Series Roadmap

This series covers Spark from the ground up:

- **Part 0 (this post)** — Overview and motivation
- **Part 1** — RDDs: the low-level API and the execution model
- **Part 2** — DataFrames and Spark SQL: the practical API
- **Part 3** — Structured Streaming: real-time processing
- **Part 4** — Performance tuning: partitioning, shuffles, and caching

By the end, you should be able to write production Spark jobs, reason about performance, and debug common failures.

## Prerequisites

This series assumes you are comfortable with:
- Python or Scala (examples will be in PySpark)
- Basic SQL
- A general sense of what distributed systems are

You do not need to have used Spark before. That is the point.
