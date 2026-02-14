---
title: "Iceberg Series, Part 0: Overview"
description: "What is Apache Iceberg, how does it differ from Delta Lake and Hudi, and why multi-engine interoperability is its defining advantage."
pubDate: 2024-10-06
author: "ifkarsyah"
tags: ["Iceberg", "Data Engineering", "Data Lake"]
image:
  src: ./iceberg-series.png
  alt: "Apache Iceberg Overview"
---

## The Open Table Format Problem

Delta Lake, Apache Hudi, and Apache Iceberg all solve the same core problem: plain Parquet on object storage lacks ACID transactions, schema enforcement, and efficient metadata management. All three add a transaction log on top of Parquet files to provide these guarantees.

But they solve it differently — and the difference that matters most in practice is **who can read the table**.

Delta Lake was created by Databricks and optimized for Spark. For years, reading a Delta table from Trino or Flink required workarounds or was simply not supported. Apache Iceberg was designed from the start as a **vendor-neutral open standard** — its specification is engine-agnostic, and every major engine treats Iceberg as a first-class citizen.

## What Apache Iceberg Is

Apache Iceberg is an **open table format specification** — not a library, not a storage engine, not a compute framework. It defines how table metadata is structured, how snapshots are tracked, how schema and partition evolution works, and how engines discover and read data files.

The specification is implemented by:
- **Apache Spark** (iceberg-spark-runtime)
- **Apache Flink** (iceberg-flink-runtime)
- **Trino** and **Presto** (native support)
- **DuckDB** (native support)
- **Snowflake** (Iceberg tables)
- **AWS Athena**, **Google BigQuery**, **Azure Synapse**

The same Iceberg table — the same files on S3 — can be written by a Spark job, queried by Trino, and read into DuckDB for local analysis, all without any conversion or export.

## The Four-Layer File Hierarchy

Iceberg's metadata model is more structured than Delta Lake's. Where Delta uses a flat sequence of JSON commit files, Iceberg organizes metadata into four layers:

```
Catalog
  └── Table metadata (metadata.json)
        └── Manifest list (snap-*.avro)
              └── Manifest files (*.avro)
                    └── Data files (*.parquet)
```

**Catalog** — tracks which tables exist and where their current metadata lives. The catalog is the entry point for all engines.

**Table metadata** (`metadata.json`) — records the current snapshot, schema history, partition spec, and sort orders.

**Manifest list** — one per snapshot. Lists all manifest files that make up this snapshot.

**Manifest files** — each covers a subset of data files, recording their paths, partition values, row counts, and column-level statistics.

**Data files** — the actual Parquet (or ORC, Avro) files containing the data.

This hierarchy is covered in depth in Part 2. For now, the key insight: this structure allows Iceberg to efficiently skip irrelevant data files using manifest-level metadata, without scanning the entire table.

## Iceberg vs Delta Lake vs Hudi

| | Apache Iceberg | Delta Lake | Apache Hudi |
|---|---|---|---|
| Origin | Netflix / Apple (2018) | Databricks (2019) | Uber (2019) |
| Governance | Apache Software Foundation | Linux Foundation | Apache Software Foundation |
| Metadata format | Avro manifests + JSON | JSON + Parquet checkpoints | Avro timeline |
| Catalog abstraction | First-class (Hive, Glue, REST, Nessie) | External (Unity Catalog, HMS) | External |
| Multi-engine | Excellent (Spark, Flink, Trino, DuckDB, Snowflake) | Good (improving) | Limited |
| Hidden partitioning | Yes (transforms: bucket, truncate, date) | No (explicit only) | No |
| Partition evolution | Yes (without rewrites) | No | No |
| Row-level deletes | Copy-on-write or merge-on-read | Copy-on-write | Merge-on-read (native) |
| Time travel | Snapshot ID or timestamp | Version or timestamp | Commit timeline |
| Cloud defaults | AWS (S3 Tables, Glue), GCP | Azure (Fabric), GCP (BigLake) | — |

**Choose Iceberg when**:
- Multiple engines need to read/write the same table (Spark ETL + Trino queries + DuckDB analysis)
- You are building on AWS (Glue Catalog, S3 Tables, Athena all default to Iceberg)
- You need partition evolution — changing how data is partitioned without rewriting history
- Vendor lock-in is a concern

**Choose Delta Lake when**:
- You are on Databricks or Azure Fabric
- Your entire stack is Spark and you want the simplest setup
- You need the richest SQL DML support (Delta's MERGE is the most mature)

## The Catalog: Iceberg's Key Differentiator

In Delta Lake, a table is identified by its path on object storage. Every engine that reads it needs to know the path — there is no registry.

In Iceberg, tables are registered in a **catalog**. The catalog maps a table name (`prod.events`) to the location of the table's current metadata file. Every engine uses the same catalog API to discover tables — no hardcoded paths.

This means:
- Rename a table in the catalog → all engines see the new name immediately
- Change the table's storage location → update the catalog entry once
- Govern access centrally in the catalog, not per-engine

Catalogs are covered in Part 3. The main options: Hive Metastore, AWS Glue, Iceberg REST Catalog, and Project Nessie (with git-like branching).

## Series Roadmap

- **Part 1 — Getting Started**: Creating Iceberg tables with Spark, reads, writes, and time travel
- **Part 2 — Table Format Internals**: Snapshots, manifest lists, manifest files — the metadata hierarchy in depth
- **Part 3 — Catalogs**: Hive, Glue, REST, and Nessie — how engines discover and coordinate on tables
- **Part 4 — Hidden Partitioning & Evolution**: Partition transforms and evolving partitioning without data rewrites
- **Part 5 — Row-Level Operations**: MERGE, UPDATE, DELETE — copy-on-write vs merge-on-read
- **Part 6 — Multi-Engine & Maintenance**: Trino, Flink, DuckDB interop; snapshot expiration and data compaction

## Key Takeaways

- Iceberg is a **table format specification** — a standard that any engine can implement, not a vendor product
- Its multi-engine story is stronger than Delta Lake's: Spark, Flink, Trino, DuckDB, and cloud warehouses all read the same table natively
- The **catalog abstraction** is what makes cross-engine access reliable — table names, not paths
- **Hidden partitioning** and **partition evolution** are unique advantages over Delta Lake
- AWS defaults to Iceberg (Glue, Athena, S3 Tables); Azure defaults to Delta (Fabric)

Next: Getting Started — creating your first Iceberg table with Spark, reading and writing, and time travel in practice.
