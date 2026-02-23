---
title: "Debezium Series, Part 5: Sink Connectors — Delta Lake & Iceberg"
description: "Landing CDC events into open table formats. Upsert and delete semantics with Delta Lake MERGE, Iceberg MERGE INTO, partition strategies, and JDBC sink for relational targets."
pubDate: 2026-02-28
author: "ifkarsyah"
domain: "Streaming"
stack: ["Debezium", "Kafka", "Delta Lake", "Iceberg"]
---

Getting events into Kafka is half the job. The other half is landing them somewhere useful. This part covers the most common sink patterns: **Delta Lake**, **Apache Iceberg**, and the **JDBC sink** for relational databases.

The central challenge is that Debezium emits a stream of inserts, updates, and deletes — but most storage systems are append-only by default. The sink layer must translate the `op` field into the right write semantics.

## The Core Problem: CDC Events Are Not Appends

A naive consumer that appends every Debezium event to a file or table ends up with the full history — every version of every row. That is useful for audit logs, but most targets want the **current state**: one row per primary key, reflecting the latest value.

```
Event stream:        c(id=1, name=alice) → u(id=1, name=bob) → d(id=1)
Append result:       [alice, bob, deleted]   ← 3 rows, all versions
Current state:       []                      ← 0 rows, only latest
```

Achieving current state from a CDC stream requires **upsert** (for inserts and updates) and **delete** (for `op: "d"`) semantics. Open table formats provide exactly this via `MERGE INTO`.

---

## Delta Lake

Delta Lake adds ACID transactions, schema enforcement, and time travel to Parquet files on object storage. Its `MERGE INTO` operation is the key to CDC ingestion.

### Architecture

```
Kafka (Debezium events)
        │
        ▼
Spark Structured Streaming
        │
        ▼  MERGE INTO (upsert + delete)
Delta Lake table (S3 / GCS / ADLS)
```

### Reading CDC Events from Kafka

```python
from pyspark.sql import SparkSession
from pyspark.sql import functions as F
from pyspark.sql.types import StructType, StructField, StringType, LongType, DoubleType

spark = SparkSession.builder \
    .appName("CDC-to-Delta") \
    .config("spark.sql.extensions", "io.delta.sql.DeltaSparkSessionExtension") \
    .config("spark.sql.catalog.spark_catalog", "org.apache.spark.sql.delta.catalog.DeltaCatalog") \
    .getOrCreate()

# Read the Debezium topic
raw = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "kafka:9092") \
    .option("subscribe", "shop.public.orders") \
    .option("startingOffsets", "earliest") \
    .load()

# Parse the Debezium envelope
after_schema = StructType([
    StructField("id", LongType()),
    StructField("customer", StringType()),
    StructField("product", StringType()),
    StructField("amount", DoubleType()),
    StructField("status", StringType()),
])

envelope_schema = StructType([
    StructField("op", StringType()),
    StructField("after", after_schema),
    StructField("before", after_schema),
])

events = raw.select(
    F.from_json(F.col("value").cast("string"), envelope_schema).alias("e")
).select(
    F.col("e.op").alias("op"),
    F.col("e.after").alias("after"),
    F.col("e.before").alias("before"),
)
```

### Applying MERGE INTO with foreachBatch

Delta Lake's `MERGE INTO` is not natively a streaming sink — we use `foreachBatch` to apply it on each micro-batch.

```python
from delta.tables import DeltaTable

def upsert_to_delta(batch_df, batch_id):
    # Separate inserts/updates from deletes
    upserts = batch_df.filter(F.col("op").isin("c", "u", "r")) \
        .select(F.col("after.*"))

    deletes = batch_df.filter(F.col("op") == "d") \
        .select(F.col("before.id").alias("id"))

    target = DeltaTable.forName(spark, "orders")

    # Apply upserts
    if upserts.count() > 0:
        target.alias("t").merge(
            upserts.alias("s"),
            "t.id = s.id"
        ).whenMatchedUpdateAll() \
         .whenNotMatchedInsertAll() \
         .execute()

    # Apply deletes
    if deletes.count() > 0:
        target.alias("t").merge(
            deletes.alias("s"),
            "t.id = s.id"
        ).whenMatchedDelete() \
         .execute()

query = events.writeStream \
    .foreachBatch(upsert_to_delta) \
    .option("checkpointLocation", "s3://my-bucket/checkpoints/orders") \
    .trigger(processingTime="30 seconds") \
    .start()

query.awaitTermination()
```

### Delta Lake Table Creation

```sql
CREATE TABLE IF NOT EXISTS orders (
    id       BIGINT,
    customer STRING,
    product  STRING,
    amount   DOUBLE,
    status   STRING
)
USING DELTA
LOCATION 's3://my-bucket/tables/orders'
PARTITIONED BY (status);
```

### Handling Deduplication

At-least-once delivery means duplicates are possible. Within a micro-batch, the same row might appear multiple times. Deduplicate before merging by keeping only the latest event per primary key:

```python
from pyspark.sql import Window

window = Window.partitionBy("id").orderBy(F.col("source_ts").desc())

deduped = events \
    .withColumn("rank", F.rank().over(window)) \
    .filter(F.col("rank") == 1) \
    .drop("rank")
```

### Delta Lake Performance Considerations

- **Small files**: `foreachBatch` with short triggers creates many small Parquet files. Run `OPTIMIZE` regularly to compact.
- **Z-ordering**: If queries filter by a non-partition column (e.g., `customer`), add `ZORDER BY (customer)` after OPTIMIZE.
- **Vacuum**: Delta retains old file versions for time travel. `VACUUM orders RETAIN 168 HOURS` cleans up files older than 7 days.

---

## Apache Iceberg

Iceberg is an open table format with first-class support for row-level deletes and updates. Its `MERGE INTO` is standardized across engines (Spark, Flink, Trino, Hive).

### Architecture

```
Kafka (Debezium events)
        │
        ▼
Flink / Spark
        │
        ▼  MERGE INTO
Iceberg table (S3 / GCS / ADLS)
        │
   catalog (Hive Metastore / REST / Nessie / Glue)
```

### Using Flink with Iceberg (Recommended)

Flink is the preferred engine for streaming CDC into Iceberg — it supports native streaming `MERGE INTO` without `foreachBatch`.

```sql
-- Flink SQL

-- Source: Debezium Kafka topic
CREATE TABLE kafka_orders (
    `before`   ROW<id BIGINT, customer STRING, product STRING, amount DECIMAL(10,2), status STRING>,
    `after`    ROW<id BIGINT, customer STRING, product STRING, amount DECIMAL(10,2), status STRING>,
    `op`       STRING,
    `source`   ROW<ts_ms BIGINT>
) WITH (
    'connector' = 'kafka',
    'topic' = 'shop.public.orders',
    'properties.bootstrap.servers' = 'kafka:9092',
    'format' = 'debezium-json'
);

-- Target: Iceberg table
CREATE TABLE iceberg_orders (
    id       BIGINT,
    customer STRING,
    product  STRING,
    amount   DECIMAL(10,2),
    status   STRING,
    PRIMARY KEY (id) NOT ENFORCED
) WITH (
    'connector' = 'iceberg',
    'catalog-name' = 'my_catalog',
    'catalog-type' = 'rest',
    'uri' = 'http://rest-catalog:8181',
    'warehouse' = 's3://my-bucket/warehouse'
);
```

Flink's Debezium format understands the envelope natively — no manual `op` parsing required:

```sql
-- Flink handles upserts and deletes automatically from the Debezium envelope
INSERT INTO iceberg_orders
SELECT `after`.id, `after`.customer, `after`.product, `after`.amount, `after`.status
FROM kafka_orders
WHERE op IN ('c', 'u', 'r');
```

For a complete upsert+delete pipeline, use the **Kafka CDC source** with Flink's `debezium-json` format — it converts the event stream into a changelog stream that Iceberg sinks handle natively.

### Iceberg Delete Files

Iceberg handles deletes differently from Delta Lake. Instead of rewriting existing Parquet files, it writes **delete files** — small files that record which row IDs are deleted. At read time, the engine merges data files with delete files.

Two types of delete files:

- **Position deletes**: Reference a specific file + row offset. Generated during streaming writes.
- **Equality deletes**: Reference a column value (e.g., `id = 42`). Easier to write but slower to read.

For CDC pipelines, Iceberg generates equality delete files by default. Over time, many small delete files slow down reads. Run compaction regularly:

```sql
-- Spark SQL
CALL my_catalog.system.rewrite_data_files(
  table => 'orders',
  strategy => 'binpack',
  options => map('min-input-files', '5')
);

CALL my_catalog.system.rewrite_position_delete_files(table => 'orders');
```

### Iceberg vs Delta Lake for CDC

| Aspect | Delta Lake | Iceberg |
|--------|-----------|---------|
| Primary engine | Spark | Flink, Spark, Trino |
| Streaming MERGE | Via `foreachBatch` | Native (Flink) |
| Delete semantics | File rewrite | Delete files (position/equality) |
| Catalog | Delta log (no external catalog needed) | External catalog required (Hive, REST, Glue) |
| Schema evolution | Supported | Supported (wider compatibility) |
| Multi-engine reads | Spark-first, others via connector | First-class: Spark, Flink, Trino, Hive |
| Time travel | Yes | Yes |

**Choose Delta Lake** if your primary engine is Spark and you want simpler operations.
**Choose Iceberg** if you need multi-engine access or use Flink for streaming.

---

## JDBC Sink Connector

For relational targets (another PostgreSQL, MySQL, or any JDBC-compatible database), the **JDBC Sink Connector** handles CDC upserts without writing custom code.

```json
{
  "name": "jdbc-sink-orders",
  "config": {
    "connector.class": "io.confluent.connect.jdbc.JdbcSinkConnector",
    "connection.url": "jdbc:postgresql://target-db:5432/analytics",
    "connection.user": "writer",
    "connection.password": "secret",

    "topics": "shop.public.orders",
    "table.name.format": "orders_replica",

    "insert.mode": "upsert",
    "pk.mode": "record_key",
    "pk.fields": "id",

    "auto.create": "true",
    "auto.evolve": "true",

    "delete.enabled": "true"
  }
}
```

**`insert.mode: upsert`**: Uses `INSERT ... ON CONFLICT DO UPDATE` (PostgreSQL) or `INSERT INTO ... ON DUPLICATE KEY UPDATE` (MySQL). This is idempotent — safe with at-least-once delivery.

**`delete.enabled: true`**: When Debezium publishes a tombstone (null value), the JDBC sink deletes the corresponding row. Requires log compaction to be enabled on the source topic, or the connector to be configured to recognize tombstones.

**`auto.create / auto.evolve`**: The sink creates the target table if it does not exist and adds columns as the schema evolves. Useful for development; in production, prefer managing DDL explicitly.

### Limitations of JDBC Sink

- Does not handle complex types (JSONB, arrays) well — they become strings
- Performance limited by single-threaded JDBC writes at low parallelism
- No native support for batch upserts in some databases — performance can be poor at high throughput

For high-throughput relational targets, consider the **Kafka Connect JDBC Sink** with `batch.size` configured, or write a custom consumer using bulk copy mechanisms (`COPY` in PostgreSQL, `LOAD DATA` in MySQL).

---

## Key Takeaways

- CDC sinks must translate `op` values into upsert (for `c`/`u`) and delete (for `d`) semantics
- **Delta Lake**: use `foreachBatch` + `MERGE INTO` with Spark; compact regularly with `OPTIMIZE`
- **Iceberg**: use Flink's native Debezium source for streaming MERGE; compact delete files with `rewrite_position_delete_files`
- **JDBC Sink**: simple relational replication with `insert.mode: upsert` and `delete.enabled: true`
- Deduplicate within micro-batches to handle at-least-once delivery duplicates
- Choose Delta Lake for Spark-first workloads; Iceberg for multi-engine or Flink-native pipelines

**Next:** [Handling Schema Changes](/blog/debezium-series-6-schema-changes)
