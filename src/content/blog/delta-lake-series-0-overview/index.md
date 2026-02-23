---
title: "Delta Lake Series, Part 0: Overview"
description: "The data lake reliability problem, what Delta Lake adds on top of Parquet, and how it compares to Apache Iceberg and Apache Hudi."
pubDate: 2024-08-04
author: "ifkarsyah"
domain: "Data Lake"
stack: ["Delta Lake", "Spark"]
image:
  src: ./delta-lake-series.png
  alt: "Delta Lake Overview"
---

## The Data Lake Reliability Problem

Object storage (S3, GCS, ADLS) is cheap, scalable, and durable. Parquet is a fast, columnar file format. Together they seem like the perfect foundation for a data lake — until you try to use them for anything beyond simple append-only batch pipelines.

The problems show up quickly:

**No atomicity.** Writing a dataset means uploading many Parquet files. If the job crashes midway, you are left with a partial write. Readers see corrupted or incomplete data.

**No isolation.** If a reader queries the table while a writer is uploading new files, it sees a mix of old and new data — or worse, reads files that are about to be deleted.

**No schema enforcement.** Nothing stops a job from writing a file with the wrong column types. The error surfaces hours later in a downstream query.

**Expensive updates and deletes.** Parquet files are immutable. To update a row, you must rewrite the entire file. There is no built-in mechanism to track what changed.

**No history.** Once a file is overwritten, the previous data is gone. Reproducing last week's report requires careful manual archiving.

**Delta Lake** solves all of these by adding a transaction log on top of Parquet and object storage.

## What Delta Lake Is

Delta Lake is an **open-source storage layer** that sits between your compute engine and your Parquet files. It adds:

- **ACID transactions**: writes are atomic — either all files are committed or none are
- **Serializable isolation**: readers always see a consistent snapshot; concurrent writers are coordinated
- **Schema enforcement**: writes that violate the table schema are rejected at write time
- **Schema evolution**: controlled, auditable schema changes without rewriting data
- **Time travel**: query any previous version of the table by timestamp or version number
- **Audit history**: a complete log of every operation ever performed on the table
- **Scalable metadata**: handles tables with millions of files without listing overhead

Delta Lake stores data as ordinary Parquet files. The only addition is a `_delta_log/` directory containing JSON and Parquet checkpoint files — the **transaction log** that tracks every change.

```
s3://my-bucket/tables/events/
├── _delta_log/
│   ├── 00000000000000000000.json   ← version 0 (table creation)
│   ├── 00000000000000000001.json   ← version 1 (first insert)
│   ├── 00000000000000000002.json   ← version 2 (second insert)
│   └── 00000000000000000010.checkpoint.parquet
├── part-00000-abc123.snappy.parquet
├── part-00001-def456.snappy.parquet
└── part-00002-ghi789.snappy.parquet
```

Because Delta Lake is just Parquet + a log, any tool that can read Parquet can read Delta Lake files directly (though it won't understand the transaction semantics without the Delta Lake library).

## Delta Lake vs Apache Iceberg vs Apache Hudi

All three are **open table formats** that add ACID and metadata management to object storage. They solve the same core problem but with different trade-offs:

| | Delta Lake | Apache Iceberg | Apache Hudi |
|---|---|---|---|
| Origin | Databricks (2019) | Netflix (2018) | Uber (2019) |
| Open governance | Linux Foundation | Apache Software Foundation | Apache Software Foundation |
| Metadata format | JSON + Parquet checkpoints | Avro + Parquet manifests | Avro timeline |
| Primary compute | Spark (+ Flink, Trino) | Spark, Flink, Trino, Hive | Spark (+ Flink) |
| Row-level updates | Merge-on-read or copy-on-write | Copy-on-write or merge-on-read | Merge-on-read (native) |
| Time travel | Yes (version or timestamp) | Yes (snapshot ID or timestamp) | Yes (commit timeline) |
| Streaming writes | Yes (Structured Streaming) | Yes | Yes (native design goal) |
| Ecosystem maturity | Largest (Databricks, Azure, GCP) | Growing fast (AWS default) | Strong at Uber-scale |

**Delta Lake** is the easiest starting point if you are already using Spark or Databricks. It has the largest ecosystem and the most mature SQL support.

**Iceberg** is the better choice for multi-engine environments (you want Trino, Flink, and Spark all reading the same tables), or if you need AWS Glue / S3 Tables integration out of the box.

**Hudi** has native streaming write support and was designed for low-latency CDC ingestion at scale — Uber's original use case.

## When to Use Delta Lake

Delta Lake is the right choice when you need:
- **Reliable batch pipelines** on object storage without worrying about partial writes
- **Upserts and deletes** on large datasets (GDPR compliance, CDC from databases)
- **Time travel** for auditing, reproducible reports, or recovering from bad writes
- **Schema governance** — enforcing structure on a shared data lake
- **Streaming + batch unified** — the same table receives streaming writes and serves batch queries

Delta Lake is not a query engine. It does not replace Spark, Trino, or DuckDB — it is the storage format those engines read and write.

## Series Roadmap

- **Part 1 — Getting Started**: Creating tables, reads, writes, and the `_delta_log` in practice
- **Part 2 — Transaction Log & ACID**: How the log enables atomicity, isolation, and conflict resolution
- **Part 3 — Schema Enforcement & Evolution**: Schema validation on write and controlled evolution
- **Part 4 — Time Travel & Versioning**: Querying history, rollback, and retention management
- **Part 5 — Performance Optimization**: OPTIMIZE, Z-ordering, data skipping, and partitioning
- **Part 6 — Streaming & CDC**: Structured Streaming writes, exactly-once, and Change Data Feed

## Key Takeaways

- Plain Parquet + object storage lacks atomicity, isolation, schema enforcement, and history
- Delta Lake adds a **transaction log** on top of Parquet — no new file format, just a `_delta_log/` directory
- It provides ACID transactions, time travel, schema enforcement, and scalable metadata
- Delta Lake, Iceberg, and Hudi solve the same problem; Delta Lake has the largest Spark/Databricks ecosystem

Next: Getting Started — creating your first Delta table, reading and writing with Spark, and what the transaction log looks like in practice.
