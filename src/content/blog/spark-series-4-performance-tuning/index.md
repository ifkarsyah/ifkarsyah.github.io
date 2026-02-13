---
title: "Spark Series, Part 4: Performance Tuning"
description: "Making Spark jobs fast — partitioning, shuffles, skew, caching, and the most common bottlenecks in production."
pubDate: 2024-02-04
author: "ifkarsyah"
tags: ["Spark", "Data Engineering", "Performance", "Big Data"]
image:
  src: ./spark-series.png
  alt: "Apache Spark Performance Tuning"
---

## Why Spark Jobs Are Slow

Most Spark performance problems fall into a small number of categories:

1. **Too many or too few partitions**
2. **Excessive shuffles**
3. **Data skew**
4. **Insufficient memory leading to spill**
5. **Repeated recomputation of the same data**

This post covers each one with diagnostics and fixes.

## Partitioning

Partitions are the unit of parallelism in Spark. Each partition is processed by one task on one executor core.

**Too few partitions** means you are not using all your cores. A 200 GB dataset with 10 partitions on a 100-core cluster will only use 10 cores.

**Too many partitions** means excessive scheduling overhead and too many small files in your output.

A reasonable target: aim for partition sizes of **128–256 MB** of uncompressed data. For a 200 GB dataset, that is roughly 800–1600 partitions.

```python
# Check current partition count
df.rdd.getNumPartitions()

# Repartition (triggers a full shuffle — use sparingly)
df = df.repartition(800)

# Coalesce (reduces partitions without a full shuffle)
df = df.coalesce(50)

# Repartition by a column (useful before writing)
df = df.repartition(200, "country")
```

Use `coalesce` when reducing partition count; it avoids a full shuffle by merging local partitions. Use `repartition` when increasing count or when you need even distribution by a column.

The default shuffle partition count is 200 (`spark.sql.shuffle.partitions`). This is almost always wrong for your workload. Set it explicitly:

```python
spark.conf.set("spark.sql.shuffle.partitions", "800")
```

## Shuffles

Shuffles are the most expensive operation in Spark. They require serializing data, writing it to disk, transferring it over the network, and deserializing it on the receiving end.

Every wide transformation triggers a shuffle: `groupBy`, `join`, `distinct`, `repartition`.

**Reduce shuffle volume:**

```python
# Bad: groupByKey collects all values for a key before aggregating
rdd.groupByKey().mapValues(sum)

# Good: reduceByKey aggregates locally first, then shuffles
rdd.reduceByKey(lambda a, b: a + b)
```

**Broadcast joins** eliminate the shuffle entirely for joins where one side is small:

```python
from pyspark.sql import functions as F

# Spark will broadcast small_df to all executors — no shuffle
result = large_df.join(F.broadcast(small_df), on="id")
```

Spark can auto-broadcast tables smaller than `spark.sql.autoBroadcastJoinThreshold` (default 10 MB). Increase this for larger lookup tables:

```python
spark.conf.set("spark.sql.autoBroadcastJoinThreshold", "50mb")
```

## Data Skew

Skew occurs when data is not evenly distributed across partitions — one partition has 100× more data than the rest. That one partition becomes the bottleneck: all other tasks finish, and your job stalls waiting for the slow task.

Diagnose skew in the Spark UI: look for stages where most tasks complete quickly but a few stragglers take much longer.

**Fix 1: Salting** — add a random prefix to skewed keys to distribute them across multiple partitions.

```python
import random

SALT_FACTOR = 20

# Expand the large side
large_df = large_df.withColumn(
    "salted_key",
    F.concat(F.col("skewed_key"), F.lit("_"), (F.rand() * SALT_FACTOR).cast("int"))
)

# Replicate the small side for each salt value
small_df = small_df.withColumn("salt", F.explode(F.array([F.lit(i) for i in range(SALT_FACTOR)])))
small_df = small_df.withColumn("salted_key", F.concat(F.col("key"), F.lit("_"), F.col("salt")))

result = large_df.join(small_df, on="salted_key")
```

**Fix 2: Adaptive Query Execution (AQE)** — Spark 3.0+ can automatically split skewed partitions at runtime.

```python
spark.conf.set("spark.sql.adaptive.enabled", "true")
spark.conf.set("spark.sql.adaptive.skewJoin.enabled", "true")
```

Enable AQE in all Spark 3+ jobs. It handles skew, coalesces small partitions, and dynamically adjusts join strategies at runtime.

## Memory and Spill

Spark executor memory is divided into:

- **Execution memory** — used for shuffles, joins, aggregations
- **Storage memory** — used for cached RDDs/DataFrames

By default, these share a unified pool (`spark.memory.fraction`, default 0.6 of heap). If execution pressure is high, cached data will be evicted.

When execution memory is insufficient, Spark **spills** to disk. Spill is orders of magnitude slower than memory operations. Watch for `Spill (Memory)` and `Spill (Disk)` columns in the Spark UI.

To reduce spill:
- Increase executor memory (`--executor-memory`)
- Increase the number of shuffle partitions so each partition is smaller
- Reduce the amount of data before shuffling (filter early, project early)

```python
# Increase executor memory and cores
spark-submit \
  --executor-memory 16g \
  --executor-cores 4 \
  --num-executors 20 \
  my_job.py
```

## Caching

Cache DataFrames that you reuse across multiple actions. Without caching, Spark recomputes the full lineage each time.

```python
df = spark.read.parquet("s3://bucket/large-dataset/")
df = df.filter(F.col("status") == "active").cache()

# Both of these will reuse the cached result
count = df.count()
summary = df.groupBy("region").agg(F.avg("value"))
```

Cache strategically:
- Cache after expensive transformations, not at the source
- Cache only what is reused — caching single-use DataFrames wastes memory
- Call `.unpersist()` when done to free up storage memory

## File Format and Compression

Reading and writing efficiently matters as much as the computation itself.

- **Parquet** over CSV or JSON for all batch pipelines. Parquet is columnar — if you only read 5 of 50 columns, it reads only those columns from disk.
- **Snappy compression** is the default for Parquet and strikes the right balance between compression ratio and CPU cost.
- **Partition pruning** requires correct partitioning at write time. If downstream jobs always filter on `date`, partition by `date`.

```python
df.write
  .partitionBy("year", "month", "day")
  .parquet("s3://bucket/output/")
```

## The Spark UI Checklist

Before declaring a job "done", spend a few minutes in the Spark UI:

- **Jobs / Stages** — are there unexpected stages? Long-running stages indicate skew or insufficient partitions.
- **Task metrics** — look for high variance in task duration (skew indicator)
- **Shuffle Read/Write** — large shuffle sizes suggest missing broadcast joins or unnecessary wide operations
- **Spill** — any spill to disk should be investigated and eliminated

## Key Takeaways

- Target 128–256 MB per partition; always tune `spark.sql.shuffle.partitions` for your workload
- Minimize shuffles; use broadcast joins for small tables and `reduceByKey` over `groupByKey`
- Enable AQE (`spark.sql.adaptive.enabled = true`) — it handles many skew and partition problems automatically
- Spill to disk is a warning sign; add memory or reduce partition size
- Use Parquet with appropriate partitioning; avoid reading more data than necessary
- Use the Spark UI — it tells you exactly where your job is spending its time

That wraps up the Spark series. The fundamentals — RDDs, DataFrames, Streaming, and tuning — cover the vast majority of what you will encounter in production data engineering.
