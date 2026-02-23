---
title: "Databricks Series, Part 6: ML Serving and Workflows"
description: "Batch and real-time model inference, Databricks Model Serving endpoints, and orchestrating the full ML pipeline with Databricks Workflows."
pubDate: 2024-11-17
author: "ifkarsyah"
domain: "Data Engineering"
stack: ["Databricks", "Delta Lake"]
image:
  src: ./databricks-series.png
  alt: "Databricks ML Serving and Workflows"
---

## Two Inference Patterns

Two distinct serving patterns exist for ML models. Most production systems use both.

**Batch inference**: run the model against the full feature table on a schedule (nightly or hourly), write predictions to a Gold Delta table. Consumers (dashboards, operational systems) read from the predictions table. Low latency requirements, handles large volumes.

**Real-time inference**: serve the model behind an HTTP endpoint that responds in milliseconds to individual feature vectors. Used for interactive applications (fraud detection, recommendation engines) where latency matters.

The architecture differs: batch inference is a Spark job; real-time inference is a managed service.

## Batch Inference Pipeline

The batch inference job reads the Production model from the MLflow registry, loads the feature table for today, applies the model as a Spark UDF (from Part 5), and writes scored records to a Gold predictions table.

Code block — full batch inference script:

```python
from pyspark.sql import SparkSession, functions as F
import mlflow.pyfunc

spark = SparkSession.builder.appName("batch-inference").getOrCreate()

# Load model once from registry — cached for the job
model_udf = mlflow.pyfunc.spark_udf(
    spark,
    model_uri="models:/churn-prediction-model/Production",
    result_type="double",
)

feature_cols = [
    "event_count_30d", "active_days_30d", "days_since_last_event",
    "purchase_count_30d", "account_age_days", "rolling_7d_events",
]

# Score today's features
predictions = (
    spark.table("main_catalog.gold.user_features")
    .filter(F.col("feature_date") == F.current_date())
    .withColumn("churn_probability", model_udf(*[F.col(c) for c in feature_cols]))
    .withColumn("predicted_churn", (F.col("churn_probability") >= 0.5).cast("boolean"))
    .withColumn("scored_at", F.current_timestamp())
    .select("user_id", "feature_date", "churn_probability", "predicted_churn", "scored_at")
)

# Write predictions to Gold table
predictions.write \
    .format("delta") \
    .mode("overwrite") \
    .option("replaceWhere", f"feature_date = '{F.current_date()}'") \
    .saveAsTable("main_catalog.gold.churn_predictions")

print(f"Scored {predictions.count():,} users")
```

This job runs nightly (or on-demand), produces predictions that downstream dashboards consume immediately.

## Real-Time Serving with Databricks Model Serving

**Databricks Model Serving** creates a managed REST endpoint from any model in the Model Registry. The endpoint auto-scales (including to zero when idle), handles authentication, and provides latency monitoring. No infrastructure to manage — Databricks handles provisioning, scaling, and ops.

Code block — creating a serving endpoint via SDK:

```python
from databricks.sdk import WorkspaceClient
from databricks.sdk.service.serving import (
    EndpointCoreConfigInput,
    ServedModelInput,
    ServedModelInputWorkloadSize,
)

w = WorkspaceClient()

# Create endpoint
endpoint = w.serving_endpoints.create(
    name="churn-prediction-endpoint",
    config=EndpointCoreConfigInput(
        served_models=[
            ServedModelInput(
                model_name="churn-prediction-model",
                model_version="3",
                workload_size=ServedModelInputWorkloadSize.SMALL,  # 1–4 concurrent requests
                scale_to_zero_enabled=True,  # cost control: scale down when idle
            )
        ]
    ),
)
print(f"Endpoint state: {endpoint.state}")
```

Then query the endpoint:

Code block — querying serving endpoint:

```python
import requests, json

WORKSPACE_URL = "https://adb-<workspace>.azuredatabricks.net"
TOKEN = dbutils.secrets.get(scope="my-scope", key="databricks-token")

# Single-row inference
features = {
    "dataframe_records": [{
        "event_count_30d": 42,
        "active_days_30d": 15,
        "days_since_last_event": 3,
        "purchase_count_30d": 2,
        "account_age_days": 180,
        "rolling_7d_events": 100,
    }]
}

response = requests.post(
    f"{WORKSPACE_URL}/serving-endpoints/churn-prediction-endpoint/invocations",
    headers={"Authorization": f"Bearer {TOKEN}"},
    json=features,
)
result = response.json()
print(f"Churn probability: {result['predictions'][0]:.2%}")
```

The endpoint returns predictions in milliseconds. Databricks handles auth, scaling, and monitoring.

## Databricks Workflows: Orchestrating the Pipeline

**Databricks Workflows** is the native job orchestrator for Databricks. A workflow is a **DAG (directed acyclic graph)** of tasks where each task is a notebook, Python script, or Delta Live Tables pipeline. Workflows replaces external schedulers (Airflow) for Databricks-pure pipelines.

Code block — creating a 4-task workflow via SDK:

```python
from databricks.sdk import WorkspaceClient
from databricks.sdk.service.jobs import (
    Task, NotebookTask, JobCluster, ClusterSpec, TaskDependency,
)

w = WorkspaceClient()

job = w.jobs.create(
    name="churn-prediction-pipeline",
    job_clusters=[
        JobCluster(
            job_cluster_key="main-cluster",
            new_cluster=ClusterSpec(
                spark_version="14.3.x-scala2.12",
                node_type_id="i3.xlarge",
                num_workers=4,
            ),
        )
    ],
    tasks=[
        Task(
            task_key="ingest",
            job_cluster_key="main-cluster",
            notebook_task=NotebookTask(notebook_path="/Repos/team/pipelines/01_ingest"),
        ),
        Task(
            task_key="featurize",
            job_cluster_key="main-cluster",
            notebook_task=NotebookTask(notebook_path="/Repos/team/pipelines/02_featurize"),
            depends_on=[TaskDependency(task_key="ingest")],
        ),
        Task(
            task_key="train",
            job_cluster_key="main-cluster",
            notebook_task=NotebookTask(notebook_path="/Repos/team/pipelines/03_train"),
            depends_on=[TaskDependency(task_key="featurize")],
        ),
        Task(
            task_key="score",
            job_cluster_key="main-cluster",
            notebook_task=NotebookTask(notebook_path="/Repos/team/pipelines/04_score"),
            depends_on=[TaskDependency(task_key="train")],
        ),
    ],
    schedule=None,  # trigger manually or add a cron schedule
)
print(f"Created job: {job.job_id}")
```

The four tasks run sequentially: `ingest` → `featurize` → `train` → `score`. All share the same Job Cluster for efficiency.

## Task Dependencies and Conditional Logic

`depends_on` specifies task order. `run_if` adds conditional execution (e.g., only retrain if new data exceeds a threshold). Use `dbutils.jobs.taskValues` to pass data between tasks.

Code block — passing values between tasks:

```python
# In the featurize task notebook:
feature_count = combined_features.count()
dbutils.jobs.taskValues.set(key="feature_count", value=feature_count)

# In the train task notebook — read the value from featurize:
feature_count = dbutils.jobs.taskValues.get(
    taskKey="featurize",
    key="feature_count",
    default=0,
)

if feature_count < 10_000:
    print(f"Insufficient data ({feature_count}). Skipping training.")
    dbutils.notebook.exit("skipped_insufficient_data")

print(f"Training with {feature_count:,} features")
```

`taskValues` is Databricks-specific — no equivalent in open-source Spark or Airflow.

## Monitoring and Alerting

Attach email alerts to workflows on failure. Query run history via SDK to build SLA monitoring.

Code block — checking job run status:

```python
from databricks.sdk.service.jobs import RunLifeCycleState

w = WorkspaceClient()

# Get recent runs
recent_runs = w.jobs.list_runs(job_id=12345, limit=5)

for run in recent_runs:
    status = run.state.life_cycle_state
    run_url = run.run_page_url
    print(f"Run {run.run_id}: {status}")

    if status == RunLifeCycleState.FAILED:
        print(f"ALERT: Pipeline failed — {run_url}")
```

This pattern is useful for alerting systems that check if data pipelines are fresh.

## The Full End-to-End Picture

Trace the complete flow from source to production prediction, connecting all six parts:

```
Source (S3 landing zone)
     ↓ Auto Loader (Part 3)
Bronze Delta Table (raw_catalog.landing.events)
     ↓ MERGE deduplication (Part 2)
Silver Delta Table (main_catalog.clean.events)
     ↓ Feature engineering (Part 4)
Gold Feature Table (main_catalog.gold.user_features)
     ↓ MLflow training (Part 5)
Model Registry (churn-prediction-model / Production)
     ↓                              ↓
Batch Predictions            Real-time Endpoint
(main_catalog.gold.          (REST API, ms latency)
 churn_predictions)
     ↑──── Databricks Workflows DAG (Part 6) ────────┘
```

The Workflows DAG orchestrates all tasks: ingestion, featurization, training, batch scoring. The same Production model serves both batch and real-time inference. Predictions flow to downstream dashboards and operational systems.

## Key Takeaways

- **Batch inference** uses `mlflow.pyfunc.spark_udf()` to score the full feature table in parallel — write predictions to Gold for downstream consumers
- **Databricks Model Serving** creates a managed HTTP endpoint from any MLflow registered model — auto-scales to zero when idle
- **Databricks Workflows** is the native orchestrator — define a DAG of tasks with `depends_on` dependencies; no external Airflow needed for Databricks-only pipelines
- **dbutils.jobs.taskValues** passes data between tasks in the same Workflow run — Databricks-specific, no OSS equivalent
- The complete pipeline: ingestion → featurization → training → batch + real-time serving, all wired in a single Workflow DAG

You now have the foundation to build, train, and serve ML models on the Databricks lakehouse. The complete pipeline lives in source control (Repos), is testable at each layer (unit tests, integration tests), and is reproducible through Delta time travel and MLflow run tracking. Data governance is enforced via Unity Catalog, and costs are transparent through DBU tracking. This is production ML engineering.
