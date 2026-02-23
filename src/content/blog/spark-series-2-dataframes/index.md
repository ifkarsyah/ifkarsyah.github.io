---
title: "Spark Series, Part 2: DataFrames and Spark SQL"
description: "The practical Spark API — working with structured data using DataFrames, schemas, and SQL queries."
pubDate: 2024-01-21
author: "ifkarsyah"
domain: "Data Engineering"
stack: ["Spark"]
image:
  src: ./spark-series.png
  alt: "Apache Spark DataFrames"
---

## From RDDs to DataFrames

RDDs are powerful but low-level. You work with raw Python or Scala objects, and Spark has no insight into the structure of your data. This means it cannot optimize your code the way a SQL engine can.

DataFrames solve this. A DataFrame is an RDD with a **schema** — a named, typed set of columns. With schema information, Spark's query optimizer (Catalyst) can apply rule-based and cost-based optimizations that would be impossible on unstructured RDDs.

The result: DataFrame code is often faster than equivalent hand-written RDD code, with less effort.

## Creating a DataFrame

```python
from pyspark.sql import SparkSession
from pyspark.sql.types import StructType, StructField, StringType, IntegerType

spark = SparkSession.builder.appName("DataFrame Example").getOrCreate()

# From a list of tuples with schema inference
df = spark.createDataFrame(
    [(1, "alice", 30), (2, "bob", 25)],
    schema=["id", "name", "age"]
)

# From a file — schema inferred automatically
df = spark.read.parquet("s3://my-bucket/users/")

# From a JSON file with schema enforcement
schema = StructType([
    StructField("id", IntegerType(), nullable=False),
    StructField("name", StringType(), nullable=True),
])
df = spark.read.schema(schema).json("s3://my-bucket/events/")
```

Always define an explicit schema when reading from files in production. Schema inference requires a full scan of the data (or a sample), and inferred types are often wrong for edge cases.

## Core Transformations

DataFrames support a rich set of transformations using the `pyspark.sql.functions` module.

```python
from pyspark.sql import functions as F

# Select and rename columns
df.select("id", F.col("name").alias("username"))

# Filter rows
df.filter(F.col("age") > 25)
df.where("age > 25")  # SQL string syntax also works

# Add or modify columns
df.withColumn("age_in_months", F.col("age") * 12)

# Aggregate
df.groupBy("country").agg(
    F.count("*").alias("user_count"),
    F.avg("age").alias("avg_age")
)

# Join
users.join(orders, on="user_id", how="left")

# Sort
df.orderBy(F.col("age").desc())
```

## Spark SQL

Spark SQL allows you to run standard SQL queries directly on DataFrames. Register a DataFrame as a temporary view, then query it with SQL.

```python
df.createOrReplaceTempView("users")

result = spark.sql("""
    SELECT country, COUNT(*) as user_count
    FROM users
    WHERE age > 18
    GROUP BY country
    ORDER BY user_count DESC
""")
```

The DataFrame API and SQL API produce identical execution plans. Use whichever is more readable for the task at hand. SQL is often cleaner for complex aggregations; the DataFrame API is better for programmatic transformations.

## Understanding the Catalyst Optimizer

When you write a DataFrame transformation, Spark does not execute it immediately. It passes your logical plan through Catalyst, the query optimizer:

1. **Parse** — convert your DataFrame operations into an unresolved logical plan
2. **Analyze** — resolve column names and types against the schema
3. **Optimize** — apply rules: predicate pushdown, constant folding, projection pruning
4. **Plan** — generate physical execution plans and pick the best one

Predicate pushdown is particularly valuable: if you filter early, Catalyst will push the filter down to the data source, so Spark only reads the rows it needs. This is especially effective with Parquet files and partition-aware storage systems.

## Schema and Data Types

Spark's type system maps to standard SQL types. Key types to know:

| Spark Type | Description |
|---|---|
| `StringType` | Variable-length string |
| `IntegerType` | 32-bit integer |
| `LongType` | 64-bit integer (use for IDs) |
| `DoubleType` | 64-bit float |
| `DecimalType(p, s)` | Fixed-precision decimal (use for money) |
| `TimestampType` | Timestamp with timezone |
| `DateType` | Date only |
| `ArrayType(T)` | Array of type T |
| `MapType(K, V)` | Key-value map |
| `StructType` | Nested struct (for JSON-like records) |

Never use `DoubleType` for monetary values — floating-point precision errors will cause incorrect aggregations. Use `DecimalType(18, 2)` instead.

## Writing DataFrames

```python
# Write as Parquet (recommended default format)
df.write.mode("overwrite").parquet("s3://my-bucket/output/")

# Partition by a column (creates directory hierarchy)
df.write.partitionBy("year", "month").parquet("s3://my-bucket/events/")

# Write as Delta (if using Delta Lake)
df.write.format("delta").mode("append").save("s3://my-bucket/delta/users/")
```

Partitioning is critical for query performance downstream. Choose partition columns that your consumers filter on frequently (e.g., `date`, `region`, `event_type`). Do not over-partition — small files are expensive to read.

## Key Takeaways

- DataFrames are schema-aware RDDs that enable query optimization
- Always define explicit schemas in production; never rely on inference
- Use `pyspark.sql.functions` for column operations — avoid Python UDFs when possible (they break optimizer visibility)
- The DataFrame API and Spark SQL are equivalent; pick the one that's clearer
- Partition output data on columns your consumers filter on

Next: Structured Streaming — applying the same DataFrame API to real-time data.
