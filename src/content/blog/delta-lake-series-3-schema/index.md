---
title: "Delta Lake Series, Part 3: Schema Enforcement & Evolution"
description: "How Delta Lake validates schemas on write, rejects incompatible data, and handles controlled schema changes over time."
pubDate: 2024-08-25
author: "ifkarsyah"
domain: "Data Lake"
stack: ["Delta Lake", "Spark"]
image:
  src: ./delta-lake-series.png
  alt: "Delta Lake Schema Enforcement and Evolution"
---

## The Schema Problem in Data Lakes

Without schema enforcement, a data lake is just a pile of files. One day an upstream team renames a column. A job writes wrong types. Someone accidentally writes CSV instead of Parquet. The errors surface hours later in a broken dashboard — if they surface at all.

Delta Lake solves this with **schema enforcement**: writes that do not match the table's schema are rejected at write time, not discovered at query time.

## Schema Enforcement

By default, Delta Lake validates every write against the table's registered schema. If the incoming DataFrame has:
- A column not in the table schema → rejected
- A column with an incompatible type → rejected
- Missing nullable columns → allowed (null is written)

```python
# Table schema: date DATE, user_id BIGINT, event_type STRING

bad_data = spark.createDataFrame([
    ("2024-01-01", 1, "click", "extra_column"),
], ["date", "user_id", "event_type", "unexpected_field"])

# This raises an AnalysisException — "unexpected_field" is not in the schema
bad_data.write.format("delta").mode("append").save("s3://my-bucket/tables/events")
```

```
AnalysisException: A schema mismatch detected when writing to the Delta table.
To enable schema migration, please set:
'.option("mergeSchema", "true")'

Table schema:
root
 |-- date: date
 |-- user_id: long
 |-- event_type: string

Data schema:
root
 |-- date: date
 |-- user_id: long
 |-- event_type: string
 |-- unexpected_field: string  ← not in table schema
```

This enforcement is why Delta Lake is called a "data lake with a schema" — it behaves more like a database table than a raw file directory.

## Schema Evolution: Additive Changes

Some schema changes are safe and backward-compatible: adding new nullable columns or widening numeric types. Delta Lake supports these automatically with `mergeSchema`:

```python
# New data has an extra column: "session_id"
new_data = spark.createDataFrame([
    ("2024-01-04", 5, "click", "sess-abc"),
], ["date", "user_id", "event_type", "session_id"])

new_data.write \
    .format("delta") \
    .mode("append") \
    .option("mergeSchema", "true") \  # allow schema evolution
    .save("s3://my-bucket/tables/events")
```

After this write, the table schema includes `session_id`. Old rows (before this write) have `null` for `session_id`. The schema change is recorded in the transaction log as a new `metaData` action.

You can also enable schema evolution globally:

```python
spark.conf.set("spark.databricks.delta.schema.autoMerge.enabled", "true")
```

**Safe additive changes** (supported with `mergeSchema`):
- Adding new nullable columns
- Widening numeric types (e.g., `INT` → `LONG`)
- Adding new nested struct fields

**Unsafe changes** (not supported by `mergeSchema` — require explicit migration):
- Renaming a column
- Changing a column's type to an incompatible one (e.g., `STRING` → `INT`)
- Dropping a column

## Schema Evolution: Overwrite Mode

For breaking changes, use `overwriteSchema` with `mode("overwrite")`. This replaces the entire table — data and schema:

```python
new_schema_data = spark.createDataFrame([
    ("2024-01-01", 1, "click", "US", "sess-abc"),
], ["date", "user_id", "event_type", "country", "session_id"])

new_schema_data.write \
    .format("delta") \
    .mode("overwrite") \
    .option("overwriteSchema", "true") \
    .save("s3://my-bucket/tables/events")
```

`overwriteSchema` replaces the schema in the transaction log. Historical versions of the table still have the old schema — time travel to those versions uses the old schema. Forward from this commit, the new schema applies.

Use `overwriteSchema` deliberately: it is a breaking change for any downstream consumer reading the table.

## Column Mapping

Delta Lake supports **column mapping** (introduced in Delta 2.0), which separates a column's display name from its physical name in Parquet files. This enables:

- Renaming columns without rewriting data
- Dropping columns without rewriting data (logical drop — physical data remains)

```python
# Enable column mapping on an existing table
spark.sql("""
    ALTER TABLE events
    SET TBLPROPERTIES (
        'delta.columnMapping.mode' = 'name',
        'delta.minReaderVersion' = '2',
        'delta.minWriterVersion' = '5'
    )
""")

# Now you can rename without rewriting files
spark.sql("ALTER TABLE events RENAME COLUMN event_type TO action_type")

# And drop without rewriting files
spark.sql("ALTER TABLE events DROP COLUMN session_id")
```

With column mapping enabled, Delta Lake maintains a mapping between logical column names (what SQL queries use) and physical column names (the Parquet field names). This is a metadata-only operation — no Parquet files are touched.

## Schema Constraints (CHECK Constraints)

Beyond type enforcement, Delta Lake supports **CHECK constraints** — boolean expressions that every row must satisfy:

```python
spark.sql("""
    ALTER TABLE events
    ADD CONSTRAINT valid_country CHECK (country IN ('US', 'DE', 'FR', 'GB'))
""")

spark.sql("""
    ALTER TABLE events
    ADD CONSTRAINT positive_amount CHECK (amount > 0)
""")
```

Writes that violate a CHECK constraint are rejected:

```
DeltaInvariantViolationException: CHECK constraint valid_country
(country IN ('US', 'DE', 'FR', 'GB')) violated by row with values:
 - country : 'XX'
```

Constraints are stored in the table's `metaData` action and enforced on every future write. Existing data is not validated retroactively when you add a constraint — add them early.

## NOT NULL Constraints

```python
spark.sql("""
    ALTER TABLE events
    ALTER COLUMN user_id SET NOT NULL
""")
```

After this, any write with a null `user_id` is rejected. Combine with CHECK constraints for robust data quality enforcement at the storage layer.

## Inspecting the Schema

```python
# Current schema
delta_table = DeltaTable.forPath(spark, "s3://my-bucket/tables/events")
print(delta_table.toDF().schema)

# Schema at a specific version (time travel)
df_v2 = spark.read.format("delta") \
    .option("versionAsOf", 2) \
    .load("s3://my-bucket/tables/events")
print(df_v2.schema)

# All constraints on the table
spark.sql("SHOW TBLPROPERTIES events").show(truncate=False)
```

## Key Takeaways

- Delta Lake **rejects writes** that don't match the registered schema — errors surface at write time, not query time
- **`mergeSchema`** enables safe additive changes: new nullable columns, widened types
- **`overwriteSchema`** replaces the schema entirely — use deliberately, it is a breaking change
- **Column mapping** enables rename and drop without rewriting Parquet files
- **CHECK constraints** and **NOT NULL** enforce data quality rules at the storage layer

**Next:** [Time Travel](/blog/delta-lake-series-4-time-travel)
