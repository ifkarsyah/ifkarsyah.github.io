---
title: "Iceberg Series, Part 6: Multi-Engine & Maintenance"
description: "Querying Iceberg from Trino, Flink, and DuckDB; expiring snapshots; rewriting data files; and keeping Iceberg tables healthy in production."
pubDate: 2024-11-17
author: "ifkarsyah"
domain: "Data Lake"
stack: ["Apache Iceberg"]
image:
  src: ./iceberg-series.png
  alt: "Apache Iceberg Multi-Engine and Maintenance"
---

## The Multi-Engine Promise in Practice

Iceberg's headline feature is multi-engine interoperability: write with Spark, query with Trino, read in DuckDB, ingest with Flink — all on the same table, all on the same S3 path, no conversion needed.

This works because every engine implements the same Iceberg spec. When Spark commits a new snapshot, it updates the metadata file and the catalog pointer. When Trino queries the table next, it reads the updated metadata file and sees the new snapshot. The engines coordinate through the catalog and the metadata files, not through each other.

## Trino

Trino is the dominant query engine for interactive analytics on Iceberg tables. It supports all major catalogs and is the primary way to serve Iceberg data to BI tools.

```properties
# trino/catalog/prod.properties
connector.name=iceberg
iceberg.catalog.type=glue           # or hive_metastore, rest
iceberg.catalog.default-warehouse-dir=s3://bucket/warehouse
hive.metastore.uri=thrift://hms:9083  # if using HMS
```

Querying with Trino SQL:

```sql
-- Standard query
SELECT date(event_at) AS date, count(*) AS events
FROM prod.analytics.events
WHERE event_at >= TIMESTAMP '2024-01-01 00:00:00'
GROUP BY 1 ORDER BY 1;

-- Time travel
SELECT * FROM prod.analytics.events
FOR VERSION AS OF 3821550127947089757;

-- Inspect metadata
SELECT * FROM prod.analytics."events$snapshots";
SELECT * FROM prod.analytics."events$files";
SELECT * FROM prod.analytics."events$partitions";

-- MERGE (Trino 426+)
MERGE INTO prod.analytics.events AS t
USING staging AS s ON t.user_id = s.user_id
WHEN MATCHED THEN UPDATE SET country = s.country
WHEN NOT MATCHED THEN INSERT VALUES (s.event_at, s.user_id, s.event_type, s.country, s.amount);
```

Trino's Iceberg connector pushes partition pruning and file-level statistics filtering down to the storage layer — queries that filter on partition columns skip manifest files before opening any Parquet file.

## Apache Flink

Flink reads and writes Iceberg tables natively, making it the primary engine for streaming ingestion into Iceberg:

```java
// Flink Table API setup
TableEnvironment tEnv = TableEnvironment.create(settings);

tEnv.executeSql(
    "CREATE CATALOG iceberg_catalog WITH (" +
    "  'type'='iceberg'," +
    "  'catalog-type'='hive'," +
    "  'uri'='thrift://metastore:9083'," +
    "  'warehouse'='s3://bucket/warehouse'" +
    ")"
);

tEnv.useCatalog("iceberg_catalog");
```

Streaming write from Kafka to Iceberg:

```sql
-- Flink SQL: Kafka source → Iceberg sink
CREATE TABLE kafka_events (
    event_at   TIMESTAMP(3),
    user_id    BIGINT,
    event_type STRING,
    country    STRING,
    WATERMARK FOR event_at AS event_at - INTERVAL '5' SECOND
) WITH (
    'connector' = 'kafka',
    'topic' = 'user-events',
    'properties.bootstrap.servers' = 'kafka:9092',
    'format' = 'json'
);

INSERT INTO iceberg_catalog.db.events
SELECT event_at, user_id, event_type, country
FROM kafka_events;
```

Flink commits Iceberg snapshots at each checkpoint interval. On restart, Flink resumes from the last checkpoint — new data that was in-flight but not checkpointed is re-read from Kafka and re-written, with Iceberg's idempotent commit mechanism preventing duplicates.

## DuckDB

DuckDB provides fast local analysis of Iceberg tables on S3 — no cluster needed:

```python
import duckdb

conn = duckdb.connect()

# Install and load the Iceberg extension
conn.execute("INSTALL iceberg; LOAD iceberg;")
conn.execute("INSTALL aws; LOAD aws;")

# Query directly from S3
result = conn.execute("""
    SELECT country, count(*) AS events
    FROM iceberg_scan('s3://bucket/warehouse/db/events')
    WHERE event_at >= '2024-01-01'
    GROUP BY country
    ORDER BY events DESC
""").fetchdf()

print(result)
```

DuckDB's Iceberg extension reads the metadata hierarchy directly — manifest list, manifest files, then Parquet data files — with the same partition and file pruning as Spark or Trino. For exploratory analysis or small-scale ETL, this is dramatically simpler than spinning up a cluster.

## PyIceberg

PyIceberg is the native Python library for Iceberg — read and write Iceberg tables without Spark:

```python
from pyiceberg.catalog import load_catalog
import pyarrow as pa

catalog = load_catalog("prod", **{
    "type": "rest",
    "uri": "http://catalog:8181",
    "credential": "client-id:client-secret",
})

table = catalog.load_table("analytics.events")

# Read as Arrow table (zero-copy)
arrow_table = table.scan(
    row_filter="country = 'US' AND event_at >= '2024-01-01'",
    selected_fields=["user_id", "event_at", "amount"],
).to_arrow()

# Convert to pandas
df = arrow_table.to_pandas()

# Write Arrow table to Iceberg
table.append(pa.Table.from_pandas(df_new_data))
```

PyIceberg is useful for: data science workflows (pandas/Arrow), lightweight ingestion scripts, and building custom tools on top of Iceberg metadata.

## Table Maintenance

Without regular maintenance, Iceberg tables accumulate stale snapshots and small files that slow down reads and waste storage.

### Expire Snapshots

Old snapshots retain references to old data files. Expire them to allow garbage collection:

```python
from pyiceberg.catalog import load_catalog

catalog = load_catalog("prod", **{"type": "rest", "uri": "http://catalog:8181"})
table = catalog.load_table("analytics.events")

# Expire snapshots older than 7 days
table.expire_snapshots().expire_older_than(
    datetime.now() - timedelta(days=7)
).commit()
```

In Spark SQL:

```sql
CALL prod.system.expire_snapshots(
    table => 'analytics.events',
    older_than => TIMESTAMP '2024-01-01 00:00:00',
    retain_last => 10   -- keep at least 10 snapshots regardless of age
);
```

Expiring snapshots removes the metadata references. The actual data files are deleted by `remove_orphan_files` (below).

### Rewrite Data Files (Compaction)

Compact small files and apply accumulated delete files:

```sql
-- Compact all files smaller than 512 MB into target size of 512 MB
CALL prod.system.rewrite_data_files(
    table => 'analytics.events',
    strategy => 'binpack',
    options => map(
        'target-file-size-bytes', '536870912',
        'min-input-files', '5'
    )
);

-- Compact with Z-order clustering
CALL prod.system.rewrite_data_files(
    table => 'analytics.events',
    strategy => 'sort',
    sort_order => 'user_id ASC, event_at ASC'
);
```

`rewrite_data_files` is especially important for MOR tables: it merges delete files back into data files, restoring read performance after many row-level changes.

### Rewrite Manifests

After many small writes, a table accumulates many manifest files — each covering only a few data files. This slows down query planning. Compact manifests:

```sql
CALL prod.system.rewrite_manifests('analytics.events');
```

This reorganizes manifests to cover larger groups of files, reducing the number of Avro files the planner must read on each query.

### Remove Orphan Files

Files that were uploaded but never committed (e.g., from failed jobs) become orphans. Clean them up:

```sql
CALL prod.system.remove_orphan_files(
    table => 'analytics.events',
    older_than => TIMESTAMP '2024-01-01 00:00:00'
);
```

Set `older_than` conservatively — at least 24 hours older than the current time, to avoid deleting files from in-progress writes.

## Recommended Maintenance Schedule

| Operation | Frequency | Notes |
|-----------|-----------|-------|
| `expire_snapshots` | Daily | Retain ≥ 7 days for time travel |
| `rewrite_data_files` | Daily (MOR) / Weekly (COW) | More frequent for MOR tables |
| `rewrite_manifests` | Weekly | After heavy write periods |
| `remove_orphan_files` | Weekly | With conservative `older_than` |

On Databricks or managed services (Tabular, AWS S3 Tables), maintenance is often automated. For self-managed deployments, schedule these as Spark jobs.

## Key Takeaways

- **Trino** is the primary interactive query engine for Iceberg; full SQL DML supported from Trino 426+
- **Flink** streams data into Iceberg with exactly-once guarantees via Iceberg's idempotent snapshot commits
- **DuckDB** + the Iceberg extension enables local analysis of S3-hosted Iceberg tables — no cluster needed
- **PyIceberg** provides native Python access (read/write) without Spark, useful for data science workflows
- Maintenance: `expire_snapshots` + `rewrite_data_files` + `rewrite_manifests` + `remove_orphan_files` — run on schedule
- MOR tables need more frequent `rewrite_data_files` to prevent read degradation from accumulated delete files

---

That wraps the Apache Iceberg Series. You now have the foundation to design, operate, and query Iceberg-based data lakes: from the catalog abstraction that enables multi-engine access, through the four-layer metadata hierarchy, hidden partitioning and schema evolution, row-level operations with copy-on-write and merge-on-read, and maintaining table health with snapshot expiration and compaction across Spark, Trino, Flink, and DuckDB.
