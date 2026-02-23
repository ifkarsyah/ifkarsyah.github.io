---
title: "Delta Lake Series, Part 5: Performance Optimization"
description: "Making Delta Lake queries fast — OPTIMIZE, Z-ordering, data skipping with column statistics, compaction, and partitioning strategies."
pubDate: 2024-09-08
author: "ifkarsyah"
domain: "Data Lake"
stack: ["Delta Lake", "Spark"]
image:
  src: ./delta-lake-series.png
  alt: "Delta Lake Performance Optimization"
---

## The Small Files Problem

Delta Lake's write model — every insert creates new Parquet files — leads naturally to the **small files problem**. A streaming job writing every 30 seconds, or a pipeline with many small partition batches, accumulates thousands of tiny files. Each file requires a separate S3 GET request, and listing thousands of files adds overhead to every query plan.

Performance optimization in Delta Lake is largely about solving this: consolidating small files, adding column-level metadata for skipping, and choosing partitioning that matches your query patterns.

## OPTIMIZE: File Compaction

`OPTIMIZE` rewrites small files into larger ones (default target: 1 GB per file):

```python
from delta.tables import DeltaTable

delta_table = DeltaTable.forPath(spark, "s3://my-bucket/tables/events")
delta_table.optimize().executeCompaction()
```

In SQL:

```sql
OPTIMIZE events;

-- Optimize only a specific partition
OPTIMIZE events WHERE date = '2024-01-01';
```

Run `OPTIMIZE` regularly — daily for batch tables, more frequently for high-frequency streaming tables. After OPTIMIZE, run VACUUM to remove the old small files.

## Z-Ordering: Multi-Dimensional Data Skipping

Z-ordering (also called Z-order clustering) co-locates related data within Parquet files based on multiple columns simultaneously. This enables **data skipping** across those columns — queries that filter on Z-ordered columns skip entire files without reading them.

```python
# OPTIMIZE + Z-order by user_id and event_type
delta_table.optimize().executeZOrderBy("user_id", "event_type")
```

In SQL:

```sql
OPTIMIZE events ZORDER BY (user_id, event_type);
OPTIMIZE events WHERE date >= '2024-01-01' ZORDER BY (user_id, event_type);
```

After Z-ordering, each Parquet file contains data that is clustered by the Z-order key. The file-level `minValues` and `maxValues` statistics stored in the transaction log then cover a narrow range of `user_id` and `event_type` values per file — so queries like `WHERE user_id = 42` skip most files.

**When to Z-order**: columns you frequently filter on that are NOT the partition key. Good candidates: `user_id`, `event_type`, `session_id`, `country`.

**Limit Z-order columns**: each additional column reduces the effectiveness of skipping for others. Two to four columns is typical; beyond that, the multi-dimensional curve becomes too spread out.

## Data Skipping with Column Statistics

Delta Lake automatically records **min/max/null statistics** for each column in each Parquet file, stored in the transaction log. This enables the query planner to skip entire files for selective filters:

```
File: part-00000.parquet
Stats: {
  "numRecords": 131072,
  "minValues": {"user_id": 1, "date": "2024-01-01"},
  "maxValues": {"user_id": 500, "date": "2024-01-01"},
  "nullCount": {"session_id": 0}
}
```

For a query `WHERE user_id = 9999`, Delta Lake reads these stats and skips any file where `maxValues.user_id < 9999`. This happens before any Parquet data is read — purely based on the transaction log metadata.

By default, Delta Lake collects stats on the first 32 columns. For wide tables, you can control which columns are indexed:

```python
spark.sql("""
    ALTER TABLE events
    SET TBLPROPERTIES ('delta.dataSkippingNumIndexedCols' = 5)
""")
```

Or use column statistics collection only on specific columns (Delta 2.3+):

```python
spark.sql("""
    ALTER TABLE events
    SET TBLPROPERTIES (
        'delta.dataSkippingStatsColumns' = 'user_id,date,event_type,country'
    )
""")
```

## Partitioning Strategy

Partitioning physically separates data into subdirectories by a column's value. A query that filters on the partition column skips entire directories — the coarsest and cheapest form of data skipping.

```python
# Write partitioned by date
df.write \
    .format("delta") \
    .partitionBy("date") \
    .save("s3://my-bucket/tables/events")
```

```
events/
├── date=2024-01-01/
│   └── part-00000.parquet
├── date=2024-01-02/
│   └── part-00000.parquet
└── date=2024-01-03/
    └── part-00000.parquet
```

**Good partition columns**:
- Columns used in almost every query's `WHERE` clause
- Low-to-medium cardinality (dates, months, regions)
- Columns that naturally segment your data lifecycle (useful for TTL or archival)

**Avoid over-partitioning**: partitioning by `user_id` or `event_id` (high cardinality) creates millions of tiny directories — worse than no partitioning. Rule of thumb: each partition directory should contain at least several hundred MB of data.

For high-cardinality filter columns, use **Z-ordering** instead of partitioning.

## Liquid Clustering (Delta 3.1+)

Z-ordering must be re-applied after new data arrives — it is not automatically maintained. **Liquid Clustering** is Delta's next-generation replacement: it clusters data incrementally as part of the normal OPTIMIZE process, without requiring a full table rewrite.

```python
# Create a table with liquid clustering
spark.sql("""
    CREATE TABLE events (
        date       DATE,
        user_id    BIGINT,
        event_type STRING,
        country    STRING
    ) USING DELTA
    CLUSTER BY (user_id, event_type)
""")
```

```sql
-- Run incremental clustering (replaces ZORDER)
OPTIMIZE events;
```

With liquid clustering, `OPTIMIZE` automatically clusters new files incrementally. You get the data skipping benefits of Z-ordering without needing to re-Z-order the entire table periodically.

Use liquid clustering for new tables (Delta 3.1+). Use Z-ordering for existing tables on older Delta versions.

## Auto-Optimize (Databricks)

On Databricks, **Auto Optimize** runs compaction automatically after writes:

```python
spark.sql("""
    ALTER TABLE events
    SET TBLPROPERTIES (
        'delta.autoOptimize.optimizeWrite' = 'true',   -- coalesce small files at write time
        'delta.autoOptimize.autoCompact' = 'true'      -- compact after writes automatically
    )
""")
```

`optimizeWrite` reduces the number of files produced per write by coalescing partitions before writing. `autoCompact` runs a lightweight OPTIMIZE in the background after each write. Together they eliminate most of the need for scheduled OPTIMIZE jobs.

## Measuring Effectiveness

Check file size distribution before and after optimization:

```python
spark.sql("""
    SELECT
        count()                                        AS num_files,
        sum(size) / 1e9                                AS total_gb,
        avg(size) / 1e6                                AS avg_file_mb,
        min(size) / 1e6                                AS min_file_mb,
        max(size) / 1e6                                AS max_file_mb
    FROM (
        SELECT size FROM delta.`s3://my-bucket/tables/events`
    )
""")

# Or via DeltaTable
delta_table.detail().select("numFiles", "sizeInBytes").show()
```

Aim for average file sizes of 128 MB – 1 GB. Many files below 10 MB indicate a compaction problem.

## Key Takeaways

- **OPTIMIZE** compacts small files into larger ones — run regularly, followed by VACUUM
- **Z-ordering** clusters data by multiple columns for multi-dimensional data skipping — ideal for high-cardinality filter columns
- **Column statistics** in the transaction log enable file-level skipping before reading any Parquet data
- **Partition** on low-cardinality columns queried in every WHERE clause; avoid partitioning on high-cardinality columns
- **Liquid Clustering** (Delta 3.1+) replaces Z-ordering with incremental maintenance — prefer it for new tables
- On Databricks, `autoOptimize` eliminates the need for scheduled compaction jobs

Next: Streaming & CDC — Structured Streaming writes to Delta, exactly-once guarantees, and Change Data Feed for downstream propagation.
