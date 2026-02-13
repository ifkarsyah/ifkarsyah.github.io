---
title: "Spark Series, Part 1: RDDs and the Execution Model"
description: "Understanding Resilient Distributed Datasets — the foundation of Spark's execution model, transformations, actions, and lazy evaluation."
pubDate: 2024-01-14
author: "ifkarsyah"
tags: ["Spark", "Data Engineering", "Big Data"]
image:
  src: /blog/spark-series.png
  alt: "Apache Spark RDDs"
---

## What Is an RDD?

A Resilient Distributed Dataset (RDD) is Spark's fundamental data abstraction. It represents an immutable, partitioned collection of records that can be operated on in parallel across a cluster.

The three properties encoded in the name:

- **Resilient** — if a partition is lost (due to node failure), Spark can recompute it from the lineage graph
- **Distributed** — data is partitioned across multiple machines
- **Dataset** — an ordered collection of records of any type

In practice, you rarely create RDDs manually today — DataFrames are the preferred API. But understanding RDDs is essential for understanding *why* Spark behaves the way it does.

## Creating an RDD

```python
from pyspark import SparkContext

sc = SparkContext("local[*]", "RDD Example")

# From a Python collection
rdd = sc.parallelize([1, 2, 3, 4, 5], numSlices=3)

# From a file
rdd = sc.textFile("s3://my-bucket/data.txt")
```

## Transformations and Actions

This is the most important concept in Spark. Operations on RDDs fall into two categories:

**Transformations** are lazy. They define a new RDD but do not compute anything. Spark records what you want to do, not when.

```python
doubled = rdd.map(lambda x: x * 2)      # transformation
filtered = doubled.filter(lambda x: x > 4)  # transformation
```

Nothing has been computed yet. Spark has built a DAG that says: "when evaluated, map then filter."

**Actions** trigger computation. They request a concrete result — a value, a count, or writing to storage.

```python
result = filtered.collect()   # action — pulls data to driver
count = filtered.count()      # action — returns a number
filtered.saveAsTextFile("/output")  # action — writes to disk
```

Only when you call an action does Spark actually execute the job.

## Why Lazy Evaluation?

Lazy evaluation enables two things:

1. **Query optimization** — Spark can reorder, fuse, and optimize transformations before executing them. A `filter` applied before a `map` is cheaper than after, and Spark can figure this out automatically.

2. **Fault tolerance** — because Spark knows the full lineage of each RDD, it can recompute lost partitions by replaying only the relevant transformations on the original source data.

## The DAG and Stages

When an action is triggered, Spark compiles the DAG into a physical execution plan. The plan is broken into **stages** — sets of transformations that can be pipelined without a shuffle.

A **shuffle** happens when data needs to move between partitions (e.g., `groupByKey`, `reduceByKey`, `join`). Shuffles are expensive: they require writing intermediate data to disk and transferring it across the network. Stage boundaries always occur at shuffle points.

```
Stage 1: textFile → filter → map
              ↓ shuffle (groupByKey)
Stage 2: groupByKey → mapValues → collect
```

Understanding stages is key to diagnosing performance issues in the Spark UI.

## Narrow vs Wide Transformations

- **Narrow** — each input partition contributes to exactly one output partition. No shuffle. Can be pipelined. Examples: `map`, `filter`, `flatMap`.
- **Wide** — input partitions may contribute to multiple output partitions. Requires a shuffle. Examples: `groupByKey`, `reduceByKey`, `join`, `distinct`.

Minimize wide transformations where possible. Prefer `reduceByKey` over `groupByKey` — it aggregates locally before shuffling, reducing the amount of data transferred.

## Caching and Persistence

If you use an RDD in multiple actions, Spark will recompute it from scratch each time by default. Use `.cache()` or `.persist()` to store it in memory after the first computation.

```python
rdd.cache()  # persist in memory (MEMORY_ONLY)
rdd.persist(StorageLevel.MEMORY_AND_DISK)  # spill to disk if needed
```

Unpersist when you no longer need the data to free memory:

```python
rdd.unpersist()
```

## Key Takeaways

- RDDs are immutable, partitioned, fault-tolerant collections
- Transformations are lazy; actions trigger execution
- Spark builds a DAG and optimizes it before running
- Shuffles are expensive — stage boundaries and performance bottlenecks cluster around them
- Cache RDDs you reuse; don't cache RDDs you use once

Next up: DataFrames — the higher-level API that you will use for 95% of real work.
