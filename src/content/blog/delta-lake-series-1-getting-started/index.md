---
title: "Delta Lake Series, Part 1: Getting Started"
description: "Creating Delta tables, reading and writing with Spark, Delta SQL, and what the _delta_log looks like in practice."
pubDate: 2024-08-11
author: "ifkarsyah"
tags: ["Delta Lake", "Data Engineering", "Data Lake"]
image:
  src: ./delta-lake-series.png
  alt: "Delta Lake Getting Started"
---

## Setup

Delta Lake works as a library on top of Apache Spark. Add the Delta Lake package when starting your Spark session:

```python
from pyspark.sql import SparkSession

spark = SparkSession.builder \
    .appName("delta-demo") \
    .config("spark.jars.packages", "io.delta:delta-spark_2.12:3.1.0") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()
```

For Databricks, Delta Lake is pre-installed — no configuration needed.

## Writing Your First Delta Table

```python
from delta.tables import DeltaTable

# Create sample data
data = [
    ("2024-01-01", 1, "click", "US"),
    ("2024-01-01", 2, "purchase", "DE"),
    ("2024-01-02", 1, "click", "US"),
]
df = spark.createDataFrame(data, ["date", "user_id", "event_type", "country"])

# Write as Delta format
df.write \
    .format("delta") \
    .mode("overwrite") \
    .partitionBy("date") \
    .save("s3://my-bucket/tables/events")
```

The destination path now contains Parquet data files and a `_delta_log/` directory. That directory is the entire transaction log — no external metastore needed for basic operations.

## Reading a Delta Table

```python
# Read by path
df = spark.read.format("delta").load("s3://my-bucket/tables/events")

# Or register as a SQL table
spark.sql("""
    CREATE TABLE IF NOT EXISTS events
    USING DELTA
    LOCATION 's3://my-bucket/tables/events'
""")

# Then query with SQL
spark.sql("SELECT * FROM events WHERE country = 'US'").show()
```

## Appending Data

```python
new_events = spark.createDataFrame([
    ("2024-01-03", 3, "click", "FR"),
    ("2024-01-03", 4, "purchase", "US"),
], ["date", "user_id", "event_type", "country"])

new_events.write \
    .format("delta") \
    .mode("append") \
    .save("s3://my-bucket/tables/events")
```

Each append is an atomic commit. Either all new files are visible or none — no partial reads.

## Upserts with MERGE

Delta Lake's `MERGE` (also called upsert) lets you insert new rows and update existing ones in a single atomic operation:

```python
from delta.tables import DeltaTable

target = DeltaTable.forPath(spark, "s3://my-bucket/tables/users")

updates = spark.createDataFrame([
    (1, "Alice", "alice@new.com"),   # existing user — update email
    (5, "Eve",   "eve@example.com"), # new user — insert
], ["user_id", "name", "email"])

target.alias("t").merge(
    updates.alias("u"),
    "t.user_id = u.user_id"
).whenMatchedUpdateAll() \
 .whenNotMatchedInsertAll() \
 .execute()
```

`MERGE` rewrites the affected Parquet files atomically. Only files containing matching rows are rewritten — not the entire table.

## Delta SQL

All Delta operations are available as SQL:

```sql
-- Create table
CREATE TABLE events (
    date       DATE,
    user_id    BIGINT,
    event_type STRING,
    country    STRING
) USING DELTA
PARTITIONED BY (date)
LOCATION 's3://my-bucket/tables/events';

-- Insert
INSERT INTO events VALUES ('2024-01-01', 1, 'click', 'US');

-- Upsert
MERGE INTO events AS t
USING updates AS u ON t.user_id = u.user_id
WHEN MATCHED THEN UPDATE SET *
WHEN NOT MATCHED THEN INSERT *;

-- Delete
DELETE FROM events WHERE date < '2024-01-01';

-- Update
UPDATE events SET country = 'GB' WHERE country = 'UK';
```

## The _delta_log in Practice

After a few operations, inspect the transaction log:

```
s3://my-bucket/tables/events/
├── _delta_log/
│   ├── 00000000000000000000.json   ← CREATE TABLE (version 0)
│   ├── 00000000000000000001.json   ← first INSERT (version 1)
│   ├── 00000000000000000002.json   ← second INSERT (version 2)
│   └── 00000000000000000003.json   ← MERGE (version 3)
```

Each JSON file records what changed in that version:

```json
{
  "commitInfo": {
    "timestamp": 1704067200000,
    "operation": "WRITE",
    "operationParameters": {"mode": "Append"}
  },
  "add": {
    "path": "date=2024-01-03/part-00000-abc.snappy.parquet",
    "size": 2048,
    "stats": "{\"numRecords\": 2, \"minValues\": {...}, \"maxValues\": {...}}"
  }
}
```

The log records `add` (new files) and `remove` (deleted files) actions. To reconstruct the current state of the table, Delta Lake replays the log from the last checkpoint forward. This is covered in depth in Part 2.

## Table History and Describe

```python
# Show all operations on the table
delta_table = DeltaTable.forPath(spark, "s3://my-bucket/tables/events")
delta_table.history().show(truncate=False)
```

```
+-------+-------------------+---------+--------------------+
|version|timestamp          |operation|operationParameters |
+-------+-------------------+---------+--------------------+
|3      |2024-01-03 10:05:00|MERGE    |...                 |
|2      |2024-01-03 10:02:00|WRITE    |{mode: Append}      |
|1      |2024-01-01 09:00:00|WRITE    |{mode: Append}      |
|0      |2024-01-01 08:55:00|CREATE   |...                 |
+-------+-------------------+---------+--------------------+
```

```sql
-- SQL equivalent
DESCRIBE HISTORY events;

-- Table details including schema and partitioning
DESCRIBE DETAIL events;
```

## Key Takeaways

- Delta Lake requires only a Spark config change — no new infrastructure
- Write with `.format("delta")` and read with `.format("delta")` or SQL `USING DELTA`
- `MERGE` enables atomic upserts — insert new rows and update existing ones in one operation
- Every write creates a JSON commit file in `_delta_log/` — the complete history of the table
- `DeltaTable.history()` shows every operation ever performed on the table

Next: Transaction Log & ACID — how the log enables atomicity, isolation between concurrent writers, and conflict resolution.
