---
title: "Iceberg Series, Part 1: Getting Started"
description: "Creating Iceberg tables with Spark, reads, writes, MERGE, time travel, and inspecting table history."
pubDate: 2024-10-13
author: "ifkarsyah"
domain: "Data Lake"
stack: ["Apache Iceberg"]
image:
  src: ./iceberg-series.png
  alt: "Apache Iceberg Getting Started"
---

## Setup with Spark

Iceberg integrates with Spark via a runtime JAR. Configure the Spark session to use the Iceberg catalog extension:

```python
from pyspark.sql import SparkSession

spark = SparkSession.builder \
    .appName("iceberg-demo") \
    .config("spark.jars.packages", "org.apache.iceberg:iceberg-spark-runtime-3.5_2.12:1.5.0") \
    .config("spark.sql.extensions", "org.apache.iceberg.spark.extensions.IcebergSparkSessionExtensions") \
    .config("spark.sql.catalog.local", "org.apache.iceberg.spark.SparkCatalog") \
    .config("spark.sql.catalog.local.type", "hadoop") \
    .config("spark.sql.catalog.local.warehouse", "s3://my-bucket/warehouse") \
    .getOrCreate()
```

Here `local` is the catalog name — all Iceberg tables are referenced as `local.database.table`. The `hadoop` catalog type stores metadata directly on the filesystem (fine for development; use Hive, Glue, or REST catalogs in production — covered in Part 3).

## Creating a Table

```sql
-- SQL DDL (recommended for clarity)
CREATE TABLE local.db.events (
    event_at   TIMESTAMP,
    user_id    BIGINT,
    event_type STRING,
    country    STRING,
    amount     DOUBLE
) USING iceberg
PARTITIONED BY (days(event_at), country)
LOCATION 's3://my-bucket/warehouse/db/events';
```

`days(event_at)` is a **partition transform** — Iceberg derives the partition value from the column automatically. No need to store a separate `date` column just for partitioning. This is covered in depth in Part 4.

In Python:

```python
from pyspark.sql.types import StructType, StructField, TimestampType, LongType, StringType, DoubleType

schema = StructType([
    StructField("event_at",   TimestampType(), False),
    StructField("user_id",    LongType(),      False),
    StructField("event_type", StringType(),    True),
    StructField("country",    StringType(),    True),
    StructField("amount",     DoubleType(),    True),
])

spark.createDataFrame([], schema) \
    .writeTo("local.db.events") \
    .partitionedBy("days(event_at)", "country") \
    .createOrReplace()
```

## Writing Data

```python
from datetime import datetime

data = [
    (datetime(2024, 1, 1, 10, 0), 1, "click",    "US", None),
    (datetime(2024, 1, 1, 11, 0), 2, "purchase", "DE", 49.99),
    (datetime(2024, 1, 2,  9, 0), 1, "click",    "US", None),
]
df = spark.createDataFrame(data, ["event_at", "user_id", "event_type", "country", "amount"])

# Append
df.writeTo("local.db.events").append()

# Overwrite matching partitions
df.writeTo("local.db.events").overwritePartitions()
```

`overwritePartitions()` replaces only the partitions represented in the new data — non-overlapping partitions are untouched. This is the safe replacement for `mode("overwrite")` in partitioned Iceberg tables.

## Reading Data

```python
# Full table scan
df = spark.table("local.db.events")
df.show()

# SQL query
spark.sql("""
    SELECT date(event_at) AS date, count(*) AS events
    FROM local.db.events
    WHERE country = 'US'
    GROUP BY 1
    ORDER BY 1
""").show()
```

## Upserts with MERGE

```sql
MERGE INTO local.db.events AS t
USING (
    SELECT * FROM updates
) AS s
ON t.user_id = s.user_id AND t.event_at = s.event_at
WHEN MATCHED AND s.amount IS NOT NULL THEN UPDATE SET t.amount = s.amount
WHEN NOT MATCHED THEN INSERT *;
```

In Python using the Iceberg `merge` API:

```python
from pyspark.sql.functions import expr

updates = spark.createDataFrame([
    (datetime(2024, 1, 1, 11, 0), 2, "purchase", "DE", 59.99),  # updated amount
    (datetime(2024, 1, 3,  8, 0), 3, "click",    "FR", None),   # new row
], ["event_at", "user_id", "event_type", "country", "amount"])

spark.sql("""
    MERGE INTO local.db.events t
    USING updates s
    ON t.user_id = s.user_id AND t.event_at = s.event_at
    WHEN MATCHED THEN UPDATE SET *
    WHEN NOT MATCHED THEN INSERT *
""")
```

## Time Travel

Iceberg tracks history as a sequence of **snapshots**. Query any past snapshot by ID or timestamp:

```python
# By snapshot ID
spark.read \
    .option("snapshot-id", "3821550127947089757") \
    .table("local.db.events") \
    .show()

# By timestamp
spark.read \
    .option("as-of-timestamp", "2024-01-02T00:00:00.000") \
    .table("local.db.events") \
    .show()
```

In SQL:

```sql
-- By snapshot ID
SELECT * FROM local.db.events VERSION AS OF 3821550127947089757;

-- By timestamp
SELECT * FROM local.db.events TIMESTAMP AS OF '2024-01-02 00:00:00';
```

## Table History and Snapshots

```python
# All snapshots
spark.sql("SELECT * FROM local.db.events.snapshots").show(truncate=False)

# Full history of operations
spark.sql("SELECT * FROM local.db.events.history").show(truncate=False)
```

```
+--------------------+-------------------+---------+--------------------+
|snapshot_id         |committed_at       |operation|summary             |
+--------------------+-------------------+---------+--------------------+
|3821550127947089757 |2024-01-01 09:00:00|append   |{added-files: 2}    |
|7204928374651039281 |2024-01-02 09:00:00|append   |{added-files: 1}    |
|1938472610293847561 |2024-01-03 10:00:00|overwrite|{added-files: 1...} |
+--------------------+-------------------+---------+--------------------+
```

Iceberg metadata tables (`snapshots`, `history`, `files`, `manifests`, `partitions`) are queryable directly — no separate admin tools needed:

```sql
-- Inspect current data files
SELECT file_path, record_count, file_size_in_bytes
FROM local.db.events.files;

-- Inspect partition statistics
SELECT partition, record_count, file_count
FROM local.db.events.partitions;
```

## Schema Evolution

Adding a column is a metadata-only operation in Iceberg — no data files are rewritten:

```sql
-- Add a column
ALTER TABLE local.db.events ADD COLUMN session_id STRING;

-- Rename a column (metadata-only, no rewrite)
ALTER TABLE local.db.events RENAME COLUMN event_type TO action_type;

-- Drop a column (metadata-only)
ALTER TABLE local.db.events DROP COLUMN session_id;

-- Change a column type (widening only, e.g., INT → LONG)
ALTER TABLE local.db.events ALTER COLUMN user_id TYPE BIGINT;
```

Unlike Delta Lake, Iceberg supports column renames and drops as pure metadata operations even without enabling a special "column mapping" mode. Iceberg tracks columns by ID, not by name — so renaming is just updating the name in the schema, not touching data files.

## Key Takeaways

- Configure Spark with the Iceberg catalog extension and a catalog name (e.g., `local`, `prod`)
- Use `writeTo().append()` and `writeTo().overwritePartitions()` — safer than `mode("overwrite")`
- `MERGE INTO` supports upserts; `DELETE` and `UPDATE` are also supported as SQL DML
- Time travel by **snapshot ID** or **timestamp** — Iceberg keeps full snapshot history
- Schema evolution (add, rename, drop, widen) is always metadata-only — Iceberg tracks columns by ID, not name
- Iceberg metadata tables (`.snapshots`, `.files`, `.partitions`) are directly queryable with SQL

Next: Table Format Internals — the four-layer file hierarchy of snapshots, manifest lists, and manifest files that makes Iceberg's metadata model unique.
