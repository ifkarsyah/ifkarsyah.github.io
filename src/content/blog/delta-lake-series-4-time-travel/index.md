---
title: "Delta Lake Series, Part 4: Time Travel & Versioning"
description: "Querying historical snapshots by version or timestamp, rolling back bad writes, auditing the table history, and managing retention with VACUUM."
pubDate: 2024-09-01
author: "ifkarsyah"
domain: "Data Lake"
stack: ["Delta Lake", "Spark"]
image:
  src: ./delta-lake-series.png
  alt: "Delta Lake Time Travel and Versioning"
---

## Why Time Travel Matters

Every write to a Delta table creates a new version. The previous version's files are not deleted — they are merely unmarked in the transaction log. This means you can query any past version of the table as if you rewound time.

Time travel solves problems that previously required manual archiving, careful backups, or just accepting data loss:

- **Audit**: what did the table look like before last night's pipeline ran?
- **Recovery**: a bad write corrupted data — roll back to the previous version
- **Reproducibility**: re-run a report as of a specific date with the exact data that existed then
- **Debugging**: compare current data against what it was two hours ago

## Querying by Version

```python
# Read the table at a specific version number
df_v3 = spark.read \
    .format("delta") \
    .option("versionAsOf", 3) \
    .load("s3://my-bucket/tables/events")

df_v3.show()
```

In SQL:

```sql
-- Query at version 3
SELECT * FROM events VERSION AS OF 3;

-- Compare current vs version 3
SELECT
    current.user_id,
    current.country,
    v3.country AS country_v3
FROM events AS current
JOIN (SELECT * FROM events VERSION AS OF 3) AS v3
  ON current.user_id = v3.user_id
WHERE current.country != v3.country;
```

## Querying by Timestamp

```python
# Read the table as it existed at a specific time
df_yesterday = spark.read \
    .format("delta") \
    .option("timestampAsOf", "2024-01-02 00:00:00") \
    .load("s3://my-bucket/tables/events")
```

In SQL:

```sql
-- Query at a specific timestamp
SELECT count(*) FROM events TIMESTAMP AS OF '2024-01-02 00:00:00';

-- Useful for reproducible daily reports
SELECT date, count(*) AS events
FROM events TIMESTAMP AS OF '2024-01-07 23:59:59'
GROUP BY date;
```

Delta Lake resolves a timestamp to the latest version that existed at or before that time.

## Viewing Table History

Before time-traveling, inspect what versions exist:

```python
from delta.tables import DeltaTable

delta_table = DeltaTable.forPath(spark, "s3://my-bucket/tables/events")
history = delta_table.history()
history.select("version", "timestamp", "operation", "operationParameters", "userName").show(truncate=False)
```

```
+-------+-------------------+-----------+--------------------------------------------+----------+
|version|timestamp          |operation  |operationParameters                         |userName  |
+-------+-------------------+-----------+--------------------------------------------+----------+
|5      |2024-01-05 14:30:00|DELETE     |{predicate: ["date < '2024-01-01'"]}        |pipeline  |
|4      |2024-01-04 10:00:00|MERGE      |{predicate: ["user_id = source.user_id"]}   |etl_job   |
|3      |2024-01-03 09:00:00|WRITE      |{mode: Append, partitionBy: ["date"]}       |etl_job   |
|2      |2024-01-02 09:00:00|WRITE      |{mode: Append, partitionBy: ["date"]}       |etl_job   |
|1      |2024-01-01 09:00:00|WRITE      |{mode: Overwrite, partitionBy: ["date"]}    |etl_job   |
|0      |2024-01-01 08:55:00|CREATE TABLE|{}                                         |admin     |
+-------+-------------------+-----------+--------------------------------------------+----------+
```

In SQL:

```sql
DESCRIBE HISTORY events;
DESCRIBE HISTORY events LIMIT 5;  -- last 5 versions only
```

## Rolling Back a Bad Write

Scenario: version 5 accidentally deleted rows it shouldn't have. Roll back to version 4:

### Option 1: Restore (Delta 1.2+)

```python
# Restore to a specific version
delta_table.restoreToVersion(4)

# Or restore to a timestamp
delta_table.restoreToTimestamp("2024-01-04 10:00:00")
```

In SQL:

```sql
RESTORE TABLE events TO VERSION AS OF 4;
RESTORE TABLE events TO TIMESTAMP AS OF '2024-01-04 10:00:00';
```

`RESTORE` creates a new version that points to the same files as the target version. It is a metadata-only operation — no data is rewritten.

### Option 2: Overwrite from Historical Read

If `RESTORE` is not available (older Delta versions), write the historical snapshot back:

```python
df_v4 = spark.read \
    .format("delta") \
    .option("versionAsOf", 4) \
    .load("s3://my-bucket/tables/events")

df_v4.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .save("s3://my-bucket/tables/events")
```

## Comparing Versions with Change Data Feed

Delta Lake's **Change Data Feed** (CDF) exposes the row-level changes between versions — not just the file-level diff. CDF records each row as `insert`, `update_preimage`, `update_postimage`, or `delete`.

Enable CDF on the table:

```python
spark.sql("""
    ALTER TABLE events
    SET TBLPROPERTIES (delta.enableChangeDataFeed = true)
""")
```

Read the changes between two versions:

```python
changes = spark.read \
    .format("delta") \
    .option("readChangeData", "true") \
    .option("startingVersion", 3) \
    .option("endingVersion", 5) \
    .load("s3://my-bucket/tables/events")

changes.select("_change_type", "user_id", "country", "_commit_version").show()
```

```
+------------------+-------+-------+----------------+
|_change_type      |user_id|country|_commit_version |
+------------------+-------+-------+----------------+
|insert            |5      |FR     |3               |
|update_preimage   |1      |US     |4               |
|update_postimage  |1      |GB     |4               |
|delete            |2      |DE     |5               |
+------------------+-------+-------+----------------+
```

CDF is the foundation of streaming CDC pipelines — covered in Part 6.

## Retention and VACUUM

Time travel is only possible as long as the old Parquet files still exist on disk. **VACUUM** deletes files that are no longer referenced and older than the retention threshold:

```python
# Default: delete files removed more than 7 days ago
delta_table.vacuum()

# Check what would be deleted without actually deleting
delta_table.vacuum(retentionHours=168)  # 7 days = 168 hours
```

To change the default retention:

```python
spark.sql("""
    ALTER TABLE events
    SET TBLPROPERTIES ('delta.deletedFileRetentionDuration' = 'interval 30 days')
""")
```

**Warning**: never VACUUM with a retention shorter than your longest-running query or Structured Streaming checkpoint interval. A streaming job checkpointed at version N needs the files from version N to exist.

```python
# Disable the safety check (dangerous — only for testing)
spark.conf.set("spark.databricks.delta.retentionDurationCheck.enabled", "false")
delta_table.vacuum(retentionHours=1)  # do not do this in production
```

## Key Takeaways

- Every Delta write creates a new version; previous versions are preserved until VACUUM removes them
- Time travel by **version** (`versionAsOf`) or **timestamp** (`timestampAsOf`) for reproducible queries and auditing
- **`RESTORE`** rolls back to a previous version in a single metadata-only operation
- **Change Data Feed** exposes row-level changes (`insert`, `update`, `delete`) between versions
- **VACUUM** physically deletes old files; keep retention ≥ 7 days, never shorter than your longest-running job

Next: Performance Optimization — OPTIMIZE, Z-ordering, data skipping, and partitioning strategies for fast queries.
