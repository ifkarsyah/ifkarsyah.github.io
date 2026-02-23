---
title: "Databricks Series, Part 0: Overview"
description: "The lakehouse platform concept, what Databricks adds on top of Spark and Delta Lake, and how it compares to alternatives."
pubDate: 2024-10-06
author: "ifkarsyah"
domain: "Data Engineering"
stack: ["Databricks", "Delta Lake"]
image:
  src: ./databricks-series.png
  alt: "Databricks Overview"
---

## The Data Lakehouse Problem

Object storage (S3, GCS, ADLS) is cheap, scalable, and durable. Parquet is a fast, columnar file format. Together they seem like the perfect foundation for data infrastructure — until you try to use them for anything beyond simple append-only batch pipelines.

The problems show up quickly:

**No atomicity.** Writing a dataset means uploading many Parquet files. If the job crashes midway, you are left with a partial write. Readers see corrupted or incomplete data.

**No isolation.** If a reader queries the table while a writer is uploading new files, it sees a mix of old and new data — or worse, reads files about to be deleted.

**No schema enforcement.** Nothing stops a job from writing a file with the wrong column types. The error surfaces hours later in a downstream query.

**Expensive updates and deletes.** Parquet files are immutable. To update a row, you must rewrite the entire file. There is no built-in mechanism to track what changed.

**No history.** Once a file is overwritten, the previous data is gone. Reproducing last week's report requires careful manual archiving.

**No governance.** There is no way to track who accessed what data, or enforce column-level access control across multiple tools.

This is the **data lake reliability problem**. Traditional data warehouses (Redshift, BigQuery, Snowflake) solve it — they provide ACID guarantees, query performance, and governance — but they lock you into a proprietary format and come with a high price tag. The **lakehouse** concept aims for the best of both: data lake openness and economics with warehouse reliability and control.

## What Is Databricks?

**Databricks** is a managed lakehouse platform built by the creators of Apache Spark and Delta Lake. It provides a fully-managed Spark runtime, a collaborative notebook environment, **Unity Catalog** for governance, **MLflow** for experiment tracking, and **Databricks Workflows** for orchestration — all integrated and managed so teams can focus on data and ML logic rather than infrastructure.

Databricks is not a new compute engine. It is a managed platform on top of open-source technology you already know:

- **Spark** for distributed computation (PySpark, Scala, SQL, R)
- **Delta Lake** for reliable, ACID-compliant storage on object storage
- **MLflow** for experiment tracking and model management
- **Apache Parquet** for columnar storage

The platform handles cluster provisioning, auto-scaling, security, and monitoring — you write code, not DevOps.

## The Lakehouse Architecture

A Databricks deployment consists of:

```
Cloud Object Storage (S3 / ADLS / GCS)
        ↓
  Databricks Workspace
  ┌──────────────────────────────┐
  │ Notebooks (Interactive)      │
  │ Workflows (Scheduled jobs)   │
  │ SQL Editor (Analytical)      │
  │ Model Serving (Real-time)    │
  └──────────────────────────────┘
        ↓
  Unity Catalog (Governance layer)
        ↓
  MLflow (Experiment tracking, model registry)
```

All data lives as **Delta tables** (Parquet + transaction log) in cloud object storage. Compute is **Spark clusters** (either All-Purpose for notebooks or Job Clusters for scheduled pipelines). Governance is **Unity Catalog** — a metastore that enables column-level access control, data lineage, and multi-workspace sharing. The **MLflow** tracking server (built into Databricks) logs experiments, models, and artifacts.

## Databricks vs Alternatives

| | Databricks | EMR | Dataproc | Snowflake |
|---|---|---|---|---|
| **Managed Spark** | Yes (native) | Partial (you manage) | Partial (you manage) | No |
| **Open storage format** | Yes (Delta Lake) | Yes (Parquet) | Yes (Parquet) | No (proprietary) |
| **Integrated ML** | Yes (MLflow) | No | No | Limited (Snowpark ML) |
| **Cost model** | DBU + cloud compute | EC2 + EMR fee | GCE + Dataproc fee | Compute credits |
| **Setup time** | Minutes | Hours | Hours | Minutes |

**Databricks** is the right choice if you already use Spark and want managed infrastructure with deep ML integration. The tradeoff is DBU (Databricks Unit) costs on top of cloud compute fees.

**EMR** and **Dataproc** are cheaper if you have strong DevOps teams and can manage Spark yourself. You own the cluster lifecycle, tuning, and troubleshooting.

**Snowflake** is excellent if you are starting fresh, have small teams, and want a fully-managed data warehouse. It does not run Spark and enforces Snowflake-specific SQL. It is a different product for a different use case.

## When to Use Databricks

Databricks is the right choice when you need:

- **Reliable batch pipelines** on object storage without worrying about partial writes or schema drift
- **Unified batch + streaming + ML** under one platform — the same tables serve BI queries, feed real-time applications, and train models
- **Governance across teams** — column-level access control, data lineage, and audit logs via Unity Catalog
- **Data science experimentation** — MLflow tracking, model registry, and one-click deployment to real-time endpoints
- **Cost efficiency at scale** — object storage is cheap; Spark parallelizes; you don't pay for a separate data warehouse

Databricks is **not** the right choice when:

- You have a small dataset that fits in DuckDB or Postgres — you don't need distributed compute
- You need extreme cost optimization and have strong ops teams to manage raw Spark
- Your ML workloads are entirely managed by a separate platform (Vertex AI, SageMaker) that already handles training and serving
- You are locked into a data warehouse (Snowflake, BigQuery) and don't want to operate two systems

## Series Roadmap

This series takes you from zero Databricks knowledge to production ML pipelines:

- **Part 0** — Platform overview and the lakehouse concept (you are here)
- **Part 1** — Getting Started: workspaces, clusters, notebooks, and submitting your first Spark job
- **Part 2** — Lakehouse Architecture: Unity Catalog, medallion (Bronze/Silver/Gold), Delta tables in practice
- **Part 3** — Data Ingestion with Auto Loader: cloudFiles, schema inference, incremental pipelines
- **Part 4** — Feature Engineering at Scale: transforming Silver tables into model-ready features using Spark DataFrames
- **Part 5** — Machine Learning with MLflow: experiment tracking, model registry, artifact management
- **Part 6** — ML Serving and Workflows: batch + real-time inference, orchestrating the full pipeline end-to-end

## Key Takeaways

- **Data lakes** (S3 + Parquet) are cheap but unreliable; **data warehouses** (Redshift, Snowflake) are reliable but expensive and proprietary
- The **lakehouse** model combines open storage (S3, Delta Lake) with warehouse-grade ACID guarantees and governance
- **Databricks** is a managed platform on top of Spark and Delta Lake — it handles infrastructure so you focus on data and ML logic
- It provides **MLflow** for experiment tracking, **Unity Catalog** for governance, and **Workflows** for orchestration
- Databricks is ideal if you already use Spark, need unified batch+streaming+ML, or require strong governance

Next: Getting Started — creating a workspace, launching a cluster, writing notebooks, and submitting your first PySpark job.
