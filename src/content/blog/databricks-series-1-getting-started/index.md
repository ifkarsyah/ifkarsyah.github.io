---
title: "Databricks Series, Part 1: Getting Started"
description: "Navigating the Databricks workspace, launching clusters, writing notebooks, and submitting your first PySpark job."
pubDate: 2024-10-13
author: "ifkarsyah"
domain: "Data Engineering"
stack: ["Databricks", "Delta Lake"]
image:
  src: ./databricks-series.png
  alt: "Databricks Getting Started"
---

## The Databricks Workspace

When you log into Databricks, you enter a **workspace** — the top-level organizational unit. A workspace is your team's Databricks environment: it contains notebooks, clusters, jobs, and shared data. If you have multiple teams or environments (dev, prod), you have multiple workspaces.

The left navigation bar provides access to:

- **Compute** — clusters and SQL warehouses
- **Workflows** — scheduled jobs and pipelines
- **Data** — catalogs, schemas, and tables (Unity Catalog)
- **ML** — experiments and models (MLflow)
- **Repos** — version control for notebooks and code

Unlike Spark's distributed RDD/DataFrame mental model, Databricks introduces a **namespace hierarchy**: workspace → catalog → schema → table. This mirrors SQL databases but is more organized. Part 2 dives deeper; for now, understand that data is organized in hierarchies, not just paths on disk.

## Cluster Types

A **cluster** is a set of compute resources (VMs) running Spark. Databricks offers two main cluster types for data engineering:

**All-Purpose Clusters** are interactive, long-running, and shared across team members. You attach notebooks to them, run code, iterate. Ideal for exploration and development. Pay per DBU-hour, with auto-scaling and auto-termination to control costs.

**Job Clusters** are ephemeral — created per-job run, run the job, then terminated. No shared state between runs. Ideal for production pipelines where you want a fresh environment each time. Slightly cheaper because you don't pay for idle time.

**SQL Warehouses** are specialized for SQL-only workloads. They optimize for analytical queries via Photon engine. Not used in this PySpark series.

Every cluster runs a **Databricks Runtime** (DBR) — a pre-configured Spark distribution with Delta Lake, MLflow, and other libraries pre-installed. DBR version maps directly to Spark: DBR 14.x = Spark 3.5, DBR 13.x = Spark 3.4. Choosing the runtime version is as important as choosing a Spark version — it locks in library versions for reproducibility.

Code block — creating an All-Purpose cluster via the Databricks SDK:

```python
from databricks.sdk import WorkspaceClient
from databricks.sdk.service.compute import ClusterSpec, AutoScale

w = WorkspaceClient()  # uses DATABRICKS_HOST and DATABRICKS_TOKEN env vars

cluster = w.clusters.create(
    cluster_name="dev-cluster",
    spark_version="14.3.x-scala2.12",  # DBR 14.3 = Spark 3.5
    node_type_id="i3.xlarge",           # instance type
    autoscale=AutoScale(min_workers=2, max_workers=8),
    autotermination_minutes=60,  # shut down after 1 hr idle
)
print(f"Cluster ID: {cluster.cluster_id}")
```

## Your First Notebook

A **notebook** in Databricks is a web-based document containing code cells (Python, SQL, Scala, R). Cells can be executed independently, and results display inline. The `spark` session is **pre-initialized** — unlike a local PySpark script, you don't call `SparkSession.builder`.

When you create a notebook, attach it to your All-Purpose cluster. Then write Python in the first cell:

```python
# spark is already available — no SparkSession needed
df = spark.read.csv(
    "/databricks-datasets/airlines/",  # built-in sample data
    header=True,
    inferSchema=True,
)
df.printSchema()
df.show(5)
```

The output displays in the browser. This is the Databricks notebook experience — rapid iteration without infrastructure.

## Databricks File System (DBFS)

**DBFS** is a distributed file system abstraction over cloud object storage. Paths like `/mnt/mydata` or `/FileStore/uploads` are DBFS. Internally, Databricks maps these to S3, ADLS, or GCS.

DBFS has a few built-in locations:

- `/databricks-datasets/` — sample datasets provided by Databricks
- `/FileStore/` — writable user file storage
- `/mnt/` — mount points for cloud storage

In production, you avoid DBFS and use cloud paths directly (`s3://my-bucket/data/`). DBFS adds overhead. But for quick experiments, it is convenient.

Code block — file system operations:

```python
# List the airlines dataset
dbutils.fs.ls("/databricks-datasets/airlines/")

# Mount S3 bucket (older pattern — Unity Catalog's volumes replace this in Part 2)
dbutils.fs.mount(
    source="s3a://my-bucket/raw/events/",
    mount_point="/mnt/raw",
    extra_configs={"fs.s3a.access.key": "YOUR_KEY", "fs.s3a.secret.key": "YOUR_SECRET"},
)

# Read from mount
events = spark.read.json("/mnt/raw/2024-10-20/")
```

## Writing a PySpark Job

Notebooks are for interactive development. For production, you write a Python script and submit it as a **job**. The script looks like any PySpark code — import, create a session, compute, write results.

Code block — standalone PySpark ETL script (`pipeline.py`):

```python
from pyspark.sql import SparkSession
from pyspark.sql import functions as F

spark = SparkSession.builder.appName("airline-stats").getOrCreate()

raw = spark.read.csv(
    "s3://my-bucket/raw/airlines/",
    header=True,
    inferSchema=True,
)

# Compute on-time departure percentage per carrier
stats = (
    raw
    .filter(F.col("DepDelay").isNotNull())
    .groupBy("UniqueCarrier")
    .agg(
        F.count("*").alias("total_flights"),
        F.sum((F.col("DepDelay") <= 15).cast("int")).alias("on_time"),
    )
    .withColumn("on_time_pct", F.round(F.col("on_time") / F.col("total_flights") * 100, 2))
)

stats.write.format("delta").mode("overwrite").save("s3://my-bucket/silver/carrier_stats/")
print(f"Computed stats for {stats.count()} carriers")
```

Save this as `pipeline.py` and upload it to your Databricks repo or workspace.

## Submitting Jobs via the UI and CLI

**From the UI:** Go to Workflows, click "Create job", and provide:

1. A name (e.g., "airline-stats")
2. Task type: Spark submit or notebook
3. Path to your Python script
4. Cluster type (new Job Cluster or All-Purpose)
5. Optional: parameters, schedule (cron), alerts

**From the CLI:** Use the Databricks CLI to submit and monitor jobs programmatically:

```bash
# Configure the CLI once
databricks configure --host https://adb-<workspace>.azuredatabricks.net/ --token <pat>

# Submit a job run
databricks jobs run-now --job-id 12345 \
  --job-parameters '{"date": "2024-10-13", "env": "prod"}'

# Monitor the run
databricks runs get --run-id 987654
```

Job **parameters** are passed via command-line arguments. In your Python script, read them:

```python
import sys

run_date = sys.argv[1] if len(sys.argv) > 1 else "2024-10-13"
env = sys.argv[2] if len(sys.argv) > 2 else "dev"
print(f"Running for {run_date} in {env}")
```

## Secrets and Configuration

Production jobs need credentials (cloud storage keys, API tokens) without hardcoding them in code. Databricks **Secrets API** solves this.

Create a secret scope once (a logical container for secrets):

```bash
databricks secrets create-scope --scope my-scope
```

Then add a secret:

```bash
databricks secrets put --scope my-scope --key storage-key
# Databricks prompts you for the value — enter your S3 secret key
```

In your notebook or job, read it:

```python
# Retrieve the secret
storage_key = dbutils.secrets.get(scope="my-scope", key="storage-key")

# Use it to configure cloud access
spark.conf.set(
    "fs.s3a.access.key",
    dbutils.secrets.get(scope="my-scope", key="s3-access-key")
)
spark.conf.set(
    "fs.s3a.secret.key",
    dbutils.secrets.get(scope="my-scope", key="s3-secret-key")
)

# Now read directly from S3
events = spark.read.json("s3a://my-bucket/raw/events/")
```

Secrets are stored in Databricks' secure vault — never exposed in job logs or code.

## Key Takeaways

- **Databricks workspace** is your team's environment; it contains notebooks, clusters, jobs, and data organized in catalogs and schemas
- **All-Purpose Clusters** are for interactive development; **Job Clusters** are ephemeral, per-job compute (cheaper for batch)
- The `spark` session is **pre-initialized** in notebooks — no `SparkSession.builder` needed
- **DBFS** is a convenience layer over cloud storage; in production use cloud paths directly (`s3://bucket/...`)
- A **Databricks job** is a Python script or notebook scheduled on a cluster — the unit of production data engineering
- Use **Databricks Secrets** to store credentials; read them with `dbutils.secrets.get()` — never hardcode credentials

Next: Lakehouse Architecture — understanding Unity Catalog, the medallion Bronze/Silver/Gold pattern, and Delta tables in practice.
