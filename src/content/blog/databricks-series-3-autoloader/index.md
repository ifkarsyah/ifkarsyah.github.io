---
title: "Databricks Series, Part 3: Data Ingestion with Auto Loader"
description: "cloudFiles format, schema inference, schema evolution, and building robust incremental ingestion pipelines on Databricks."
pubDate: 2024-10-27
author: "ifkarsyah"
domain: "Data Engineering"
stack: ["Databricks", "Delta Lake"]
image:
  src: ./databricks-series.png
  alt: "Databricks Auto Loader"
---

## The Incremental Ingestion Problem

Landing files in cloud storage is the first step in most data pipelines. The naive approach — `spark.read.json("s3://bucket/landing/")` — rescans **all** files every run. For buckets with thousands of daily files, this is slow and expensive. You want to process only **new files since the last run**, detect schema changes, and recover from failure without reprocessing or losing data.

Manual tracking (writing offsets to a config file, remembering which files were processed) is error-prone. External tools (Kafka) solve this for streaming, but what if data arrives as S3 files?

**Auto Loader** solves incremental ingestion for cloud files.

## How Auto Loader Works

**Auto Loader** (`cloudFiles` format source in Spark) uses cloud-native file notification services (AWS S3 Event Notifications, Azure Event Grid) or directory listing to detect new files. It records progress in a **checkpoint** directory — on restart, it picks up only files not yet processed.

Internally, Auto Loader is a **Structured Streaming** job. It can run continuously or be triggered on a schedule. You get the incremental semantics of streaming with the batch-job simplicity of scheduled notebooks.

No external infrastructure needed — just point it at a source directory and a checkpoint location.

## Basic Auto Loader Pipeline

The minimal pattern: `readStream` with `format("cloudFiles")`, write stream to a Delta table with a checkpoint. Use `trigger(availableNow=True)` for scheduled batch-style runs.

Code block — basic Auto Loader pipeline:

```python
from pyspark.sql import SparkSession
from pyspark.sql import functions as F

spark = SparkSession.builder.appName("autoloader-ingest").getOrCreate()

# Read new JSON files incrementally as they land in S3
raw_stream = (
    spark.readStream
    .format("cloudFiles")
    .option("cloudFiles.format", "json")
    .option("cloudFiles.schemaLocation", "s3://my-bucket/checkpoints/events/schema/")
    .load("s3://my-bucket/raw/events/")
)

# Add ingestion metadata
raw_with_meta = raw_stream.withColumn("_ingested_at", F.current_timestamp())

# Write to Bronze Delta table
query = (
    raw_with_meta
    .writeStream
    .format("delta")
    .outputMode("append")
    .option("checkpointLocation", "s3://my-bucket/checkpoints/events/stream/")
    .trigger(availableNow=True)  # process all new files, then stop
    .toTable("raw_catalog.landing.events")
)

query.awaitTermination()
print("Ingestion complete")
```

**`cloudFiles.schemaLocation`** stores the inferred schema for reuse.

**`checkpointLocation`** stores streaming state — Auto Loader uses this to remember which files have been processed.

**`trigger(availableNow=True)`** processes all new files since the last checkpoint and exits. This is the modern pattern for scheduled batch-style ingestion. It is safe to call multiple times — idempotent, no duplicates.

## Schema Inference and the schemaLocation

Auto Loader infers schema from the first batch of files and stores it in `schemaLocation`. On subsequent runs, it reads the stored schema (fast) rather than scanning files again.

If upstream data changes and files have new columns, Auto Loader can **detect** this. But by default it uses the stored schema for all files. You can force re-inference by deleting the schema location:

Code block — inspecting and resetting schema:

```python
# Check the inferred schema stored in schemaLocation
schema_df = spark.read.json(
    "s3://my-bucket/checkpoints/events/schema/_schema"
)
schema_df.printSchema()

# If schema is stale, reset it — Auto Loader will re-infer on next run
dbutils.fs.rm("s3://my-bucket/checkpoints/events/schema/", recurse=True)
```

## Schema Evolution with cloudFiles.schemaEvolutionMode

When upstream data adds new columns, Auto Loader can handle them in four modes:

`addNewColumns` — (safe default) new columns are added to the table, existing pipeline continues

`rescue` — unknown columns are placed into a `_rescued_data` JSON column (good for audit)

`failOnNewColumns` — strict mode; fail if schema changes

`none` — ignore unknown columns

Code block — schema evolution with rescue mode:

```python
raw_stream = (
    spark.readStream
    .format("cloudFiles")
    .option("cloudFiles.format", "json")
    .option("cloudFiles.schemaLocation", "s3://my-bucket/checkpoints/events/schema/")
    .option("cloudFiles.schemaEvolutionMode", "rescue")  # unknown columns → _rescued_data
    .load("s3://my-bucket/raw/events/")
)

# Inspect rescued data to audit upstream schema changes
raw_stream.filter(F.col("_rescued_data").isNotNull()).select("_rescued_data").show(5)
```

Using `rescue` mode is a best practice — you discover upstream changes before allowing schema evolution. Part 4 and beyond trust Silver is correctly typed.

## Ingesting Multiple File Formats

Auto Loader works with any format. The only difference is `cloudFiles.format`. Highlight: **Parquet and Delta sources don't need schema inference** (schema is embedded in files). For CSV, always set `cloudFiles.inferColumnTypes = true`.

Code block — CSV and Parquet variants:

```python
# CSV with type inference
csv_stream = (
    spark.readStream
    .format("cloudFiles")
    .option("cloudFiles.format", "csv")
    .option("cloudFiles.schemaLocation", "s3://my-bucket/checkpoints/orders/schema/")
    .option("cloudFiles.inferColumnTypes", "true")
    .option("header", "true")
    .load("s3://my-bucket/raw/orders/")
)

# Parquet (no inference needed, schema in files)
parquet_stream = (
    spark.readStream
    .format("cloudFiles")
    .option("cloudFiles.format", "parquet")
    .option("cloudFiles.schemaLocation", "s3://my-bucket/checkpoints/logs/schema/")
    .load("s3://my-bucket/raw/logs/")
)
```

## Handling Bad Records

Real data has malformed records. Use `columnNameOfCorruptRecord` (JSON/CSV) and `cloudFiles.badRecordsPath` to **quarantine** malformed files rather than failing the entire pipeline.

Code block — quarantine bad records:

```python
raw_stream = (
    spark.readStream
    .format("cloudFiles")
    .option("cloudFiles.format", "json")
    .option("cloudFiles.schemaLocation", "s3://my-bucket/checkpoints/events/schema/")
    .option("cloudFiles.badRecordsPath", "s3://my-bucket/quarantine/events/")
    .option("columnNameOfCorruptRecord", "_corrupt_record")
    .load("s3://my-bucket/raw/events/")
)

# Split: clean rows go to Bronze, corrupt rows are skipped
clean = raw_stream.filter(F.col("_corrupt_record").isNull())
quarantine = raw_stream.filter(F.col("_corrupt_record").isNotNull())

# Write clean to Bronze
clean.writeStream \
    .format("delta") \
    .outputMode("append") \
    .option("checkpointLocation", "s3://my-bucket/checkpoints/events/clean/") \
    .trigger(availableNow=True) \
    .toTable("raw_catalog.landing.events") \
    .awaitTermination()
```

Auto Loader copies malformed files to `badRecordsPath`. You can inspect them later to understand why they failed.

## Auto Loader vs COPY INTO

Databricks also provides **COPY INTO** — a SQL-based incremental ingestion tool. Contrast:

**COPY INTO** is stateless — it tracks which files it loaded by storing a list of file paths in the Delta table itself. Idempotent, simple. Use for one-time or low-frequency loads.

**Auto Loader** is stateful — it maintains a checkpoint. It supports continuous or scheduled operation, schema evolution, and fine-grained control. Use for production incremental pipelines.

```python
# COPY INTO (simpler, stateless)
spark.sql("""
    COPY INTO raw_catalog.landing.events
    FROM 's3://my-bucket/raw/events/'
    FILEFORMAT = JSON
""")

# Auto Loader (stateful, better for production)
# Use the pattern above with readStream + checkpoint
```

## Key Takeaways

- **Auto Loader** (`cloudFiles` format) detects new files using cloud notifications — no manual offset tracking, no rescanning
- **schemaLocation** stores the inferred schema; reused on subsequent runs for speed
- **checkpointLocation** tracks which files have been processed — ensures no duplicates even if the job fails and restarts
- **cloudFiles.schemaEvolutionMode = "rescue"** is safest for production — unknown columns go to `_rescued_data` instead of failing the job
- **trigger(availableNow=True)** is the right pattern for scheduled batch-style runs — process all new files, then stop
- **badRecordsPath** quarantines malformed files; the pipeline continues rather than crashing

Next: Feature Engineering at Scale — transforming Silver Delta tables into ML-ready features using Spark DataFrames and Delta tables as a feature store.
