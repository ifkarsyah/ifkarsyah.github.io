---
title: "Databricks Series, Part 2: Lakehouse Architecture"
description: "Unity Catalog for governance and discovery, the medallion Bronze/Silver/Gold pattern, and Delta tables as the storage foundation."
pubDate: 2024-10-20
author: "ifkarsyah"
tags: ["Databricks", "Data Engineering", "MLOps"]
image:
  src: ./databricks-series.png
  alt: "Databricks Lakehouse Architecture"
---

## The Medallion Architecture

The **medallion** (or multi-hop) architecture organizes data into three quality layers within a single lakehouse. Each layer serves a different purpose in the data pipeline:

**Bronze** is raw ingestion — land data exactly as received, no transformations, no validation. Store the original payload plus ingestion metadata.

**Silver** is cleaned and conformed — deduplicated, typed, validated, joined with reference data. Silver tables are the "source of truth" within the organization.

**Gold** is business-aggregated — KPIs, feature tables, report-ready datasets. Gold tables are directly consumed by dashboards, operational systems, and ML models.

This three-layer pattern maps directly to **Unity Catalog's** three-level namespace: `catalog.schema.table`. You create a catalog for each layer:

```
Source Systems
    ↓ (Auto Loader / Kafka)
Bronze: raw_catalog.landing.events        ← exact replica, no transforms
    ↓ (deduplicate, cast types, validate)
Silver: main_catalog.clean.events         ← conformed, quality-checked
    ↓ (aggregate, join, compute KPIs)
Gold:   main_catalog.gold.daily_summary   ← business-ready, query-optimized
```

This pattern enforces clean separation of concerns. Each layer has a clear contract — Bronze ingests anything, Silver guarantees quality, Gold guarantees business logic is applied correctly.

## Unity Catalog: The Governance Layer

**Unity Catalog** is Databricks' metastore for managing data assets across your organization. It replaces the workspace-local **Hive metastore** (the old way) with a centralized, cross-workspace catalog system.

Unity Catalog introduces a three-level namespace:

- **Catalog** — top level, often one per environment (raw_catalog, main_catalog) or team (finance_catalog)
- **Schema** — middle level, groups related tables (clean schema, gold schema)
- **Table** — individual dataset

A fully-qualified table name is `main_catalog.clean.events`, not just `events` or `default.events`.

Beyond the namespace, Unity Catalog provides:

- **Column-level access control** — allow analysts to read demographic columns but not payment data
- **Row-level security** — users see only their own company's data via predicates
- **Data lineage** — track which tables are inputs to which jobs (built-in, automatic)
- **Governance and audit** — who accessed what, when, all logged

There is no open-source equivalent to Unity Catalog. It is a Databricks-specific feature that requires Databricks workspace.

Code block — setting up Unity Catalog namespaces:

```python
# Create catalogs (usually done once by workspace admin)
spark.sql("CREATE CATALOG IF NOT EXISTS raw_catalog")
spark.sql("CREATE CATALOG IF NOT EXISTS main_catalog")

# Create schemas within each catalog
spark.sql("CREATE SCHEMA IF NOT EXISTS raw_catalog.landing")
spark.sql("CREATE SCHEMA IF NOT EXISTS main_catalog.clean")
spark.sql("CREATE SCHEMA IF NOT EXISTS main_catalog.gold")

# Grant access control
spark.sql("GRANT USE CATALOG ON CATALOG main_catalog TO `data-engineers`")
spark.sql("GRANT SELECT ON SCHEMA main_catalog.clean TO `data-analysts`")
```

## Delta Tables in Databricks

Delta Lake is pre-configured in Databricks — no jars to add, no SparkSession configuration needed. Creating a Delta table in Databricks is as simple as:

```python
df.write.format("delta").mode("overwrite").saveAsTable("main_catalog.clean.events")
```

Two table types exist:

**Managed tables** — Databricks owns the data files. When you `DROP TABLE`, the files are deleted. Use this for derived data (Silver, Gold).

**External tables** — You provide the storage path. When you `DROP TABLE`, the files remain. Use this for Bronze (you want to preserve raw data even if the table is dropped).

Code block — creating both types:

```python
# Managed table: Databricks controls storage location
spark.sql("""
    CREATE TABLE IF NOT EXISTS main_catalog.clean.events (
        event_id  STRING,
        user_id   BIGINT,
        event_ts  TIMESTAMP,
        event_type STRING,
        country   STRING
    )
    USING DELTA
    PARTITION BY (country)
""")

# External table: you control storage, Databricks controls metadata
spark.sql("""
    CREATE TABLE IF NOT EXISTS raw_catalog.landing.events
    USING DELTA
    LOCATION 's3://my-bucket/raw/events/'
""")

# Write data using saveAsTable (appends to existing, or creates if missing)
df.write.mode("append").saveAsTable("main_catalog.clean.events")
```

## Building the Bronze Layer

Bronze tables are **append-only** — never transform, always preserve the original payload. Add ingestion metadata columns: `_ingested_at` (timestamp), `_source_file` (origin file path), `_processing_date` (the date the data is for, used for partitioning).

Code block — Bronze table write with metadata:

```python
from pyspark.sql import functions as F

# Read raw JSON from cloud storage
raw_df = (
    spark.read
    .format("json")
    .load("s3://my-bucket/raw/events/2024/10/20/")
)

# Add ingestion columns (preserve original payload)
bronze_df = raw_df.withColumns({
    "_ingested_at": F.current_timestamp(),
    "_source_file": F.input_file_name(),  # tracks which file this row came from
    "_processing_date": F.current_date(),
})

# Append to Bronze table (never overwrite)
bronze_df.write \
    .format("delta") \
    .mode("append") \
    .partitionBy("_processing_date") \
    .saveAsTable("raw_catalog.landing.events")
```

By partitioning on `_processing_date`, you get fast queries for recent data without scanning the entire Bronze table.

## Building the Silver Layer

Silver reads from Bronze and applies: type casting, null handling, deduplication, and joins with reference data. Use **MERGE** for idempotent Silver writes — re-running a job shouldn't create duplicate rows.

Code block — Bronze-to-Silver MERGE (deduplication):

```python
from delta.tables import DeltaTable

bronze = spark.table("raw_catalog.landing.events")

# Deduplicate by event_id within today's processing window
deduped = (
    bronze
    .filter(F.col("_processing_date") == F.current_date())
    .dropDuplicates(["event_id"])
    .select(
        F.col("event_id"),
        F.col("user_id").cast("bigint"),
        F.to_timestamp("event_ts").alias("event_ts"),
        F.col("event_type"),
        F.col("country"),
    )
)

# MERGE into Silver: insert if event_id not exists, skip if exists
silver_table = DeltaTable.forName(spark, "main_catalog.clean.events")

silver_table.alias("t").merge(
    deduped.alias("s"),
    "t.event_id = s.event_id"
).whenNotMatchedInsertAll().execute()
```

The MERGE pattern is idempotent — if you run the job twice with the same data, the second run does nothing (no duplicate rows inserted).

## Building the Gold Layer

Gold aggregates Silver data for business consumption. Gold tables are often **overwritten** on each run because they are derived and reproducible from Silver.

Code block — Silver-to-Gold aggregation:

```python
silver = spark.table("main_catalog.clean.events")

# Daily summary: event count and unique users per country
daily_summary = (
    silver
    .filter(F.to_date("event_ts") == F.current_date())
    .groupBy(F.to_date("event_ts").alias("event_date"), "country", "event_type")
    .agg(
        F.count("*").alias("event_count"),
        F.countDistinct("user_id").alias("unique_users"),
    )
)

# Overwrite only today's partition (faster than full overwrite)
daily_summary.write \
    .format("delta") \
    .mode("overwrite") \
    .option("replaceWhere", f"event_date = '{F.current_date()}'") \
    .saveAsTable("main_catalog.gold.daily_summary")
```

The `replaceWhere` option is key — it overwrites only the partition for today, not the entire table. This is efficient and safe.

## Delta Table Properties and Optimization

Databricks provides Delta table properties that optimize performance and reliability:

`delta.autoOptimize.optimizeWrite` — auto-sizes files during writes to avoid the "small files problem"

`delta.autoOptimize.autoCompact` — background compaction merges small files (you don't need to call OPTIMIZE)

`delta.enableDeletionVectors` — faster updates/deletes by tracking deleted rows instead of rewriting files

These properties are **enabled by default in Databricks** but **disabled in open-source Delta Lake** — a common gotcha for code moving between environments.

Code block — enabling and using Delta optimizations:

```python
# Enable Databricks-specific optimizations
spark.sql("""
    ALTER TABLE main_catalog.clean.events
    SET TBLPROPERTIES (
        'delta.autoOptimize.optimizeWrite' = 'true',
        'delta.autoOptimize.autoCompact'   = 'true',
        'delta.enableDeletionVectors'      = 'true'
    )
""")

# Z-order for faster queries on filter columns
spark.sql("""
    OPTIMIZE main_catalog.clean.events
    ZORDER BY (user_id, event_ts)
""")

# Check table properties
props = spark.sql("SHOW TBLPROPERTIES main_catalog.clean.events").collect()
```

**Z-order** clusters rows so that values in specified columns are co-located on disk — queries filtering by those columns scan fewer files.

## Key Takeaways

- **Bronze/Silver/Gold** is the medallion pattern — raw ingestion → cleaned data → business aggregations — maps to separate catalogs in Unity Catalog
- **Unity Catalog** provides column-level access control, row-level security, and automatic data lineage — no OSS equivalent
- **Managed tables** are owned by Databricks (dropped table = deleted data); **external tables** preserve data on drop (use for Bronze)
- **MERGE** into Silver ensures idempotency — re-running a job produces the same result without duplicating rows
- **Overwrite with `replaceWhere`** in Gold — fast, efficient, and safe
- **autoOptimize** and **autoCompact** are Databricks defaults; open-source Delta requires explicit OPTIMIZE commands

Next: Data Ingestion with Auto Loader — cloudFiles, schema inference, and building incremental ingestion pipelines on Databricks.
