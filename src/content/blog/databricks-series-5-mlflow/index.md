---
title: "Databricks Series, Part 5: Machine Learning with MLflow"
description: "Tracking experiments, logging models and artifacts, comparing runs, and managing the model lifecycle with MLflow on Databricks."
pubDate: 2024-11-10
author: "ifkarsyah"
tags: ["Databricks", "Data Engineering", "MLOps"]
image:
  src: ./databricks-series.png
  alt: "Databricks MLflow"
---

## MLflow on Databricks

**MLflow** is an open-source ML lifecycle platform that tracks experiments, packages models, and manages deployment. On Databricks, MLflow is **pre-installed and fully managed** — no server to run, no database to configure. Every Databricks workspace has a built-in MLflow Tracking Server. Contrast with open-source MLflow: you run `mlflow server` yourself and point your code at it. On Databricks, `mlflow.set_tracking_uri("databricks")` is the default.

Key concepts:

**Experiment** — a named container for training runs. Example: `/Users/ifkarsyah/churn-prediction`.

**Run** — a single execution of training code. Captures parameters, metrics, and artifacts (model files, plots, data samples).

**Model** — a serialized model logged during a run.

**Model Registry** — a centralized store for versioning and lifecycle management (Staging → Production → Archived).

## Tracking Your First Experiment

An experiment is created automatically when you first write to it. A run is created explicitly with `mlflow.start_run()`. Inside a run, log parameters (hyperparameters), metrics (AUC, loss), and artifacts (model files, figures).

Code block — basic MLflow tracking with scikit-learn:

```python
import mlflow
import mlflow.sklearn
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score

# Set experiment name
mlflow.set_experiment("/Users/ifkarsyah/churn-prediction")

with mlflow.start_run(run_name="gbm-baseline"):
    # Log hyperparameters
    params = {"n_estimators": 100, "max_depth": 4, "learning_rate": 0.1}
    mlflow.log_params(params)

    # Load features from Gold layer
    features_pdf = (
        spark.table("main_catalog.gold.user_features")
        .filter("feature_date = current_date()")
        .toPandas()
    )

    X = features_pdf.drop(columns=["user_id", "feature_date"])
    y = features_pdf["label"]

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    # Train model
    model = GradientBoostingClassifier(**params)
    model.fit(X_train, y_train)

    # Log metrics
    auc = roc_auc_score(y_test, model.predict_proba(X_test)[:, 1])
    mlflow.log_metric("auc_roc", auc)

    # Log model as artifact
    mlflow.sklearn.log_model(model, artifact_path="model")
    print(f"AUC: {auc:.4f}")
```

When the `with` block exits, MLflow automatically marks the run as complete. The model, parameters, and metrics are all stored in the workspace MLflow backend.

## MLflow Autolog

`mlflow.autolog()` automatically logs parameters, metrics, and the model for supported frameworks (sklearn, XGBoost, LightGBM, PyTorch) without explicit `log_param()` calls. Enable it once at the top of your notebook.

Code block — autolog pattern:

```python
import mlflow

mlflow.autolog()  # enable autolog globally

with mlflow.start_run(run_name="gbm-autolog"):
    model = GradientBoostingClassifier(n_estimators=200, max_depth=5)
    model.fit(X_train, y_train)
    # ^ params, model, and feature importance are logged automatically

    # Still log custom metrics explicitly
    auc = roc_auc_score(y_test, model.predict_proba(X_test)[:, 1])
    mlflow.log_metric("auc_roc", auc)

    # Autolog captured: params, model pickle, sklearn signature, feature importance
```

Autolog handles the boilerplate. You add custom metrics (business KPIs) explicitly.

## Logging Artifacts and Custom Objects

Beyond the model, log **artifacts**: feature importance plots, confusion matrices, data samples, config files. `mlflow.log_artifact()` uploads any local file; `mlflow.log_figure()` logs a matplotlib figure directly.

Code block — logging custom artifacts:

```python
import matplotlib.pyplot as plt
import numpy as np

with mlflow.start_run(run_name="gbm-with-artifacts"):
    model = GradientBoostingClassifier(n_estimators=100, max_depth=4)
    model.fit(X_train, y_train)

    # Plot feature importance
    fig, ax = plt.subplots(figsize=(10, 6))
    feature_names = X_train.columns
    importances = model.feature_importances_
    indices = np.argsort(importances)[::-1]
    ax.bar(range(len(importances)), importances[indices])
    ax.set_xticks(range(len(importances)))
    ax.set_xticklabels([feature_names[i] for i in indices], rotation=45)
    ax.set_title("Feature Importance")
    plt.tight_layout()

    # Log the figure
    mlflow.log_figure(fig, "feature_importance.png")

    # Log the model
    mlflow.sklearn.log_model(model, "model")

    # Log metrics
    auc = roc_auc_score(y_test, model.predict_proba(X_test)[:, 1])
    mlflow.log_metric("auc_roc", auc)
```

Artifacts are stored alongside the run — accessible from the MLflow UI for inspection and debugging.

## Comparing Runs

After running multiple experiments (different hyperparameters, feature sets), use the **MLflow UI** to compare runs side-by-side. Programmatically, use `mlflow.search_runs()` to find the best run.

Code block — finding the best run:

```python
import mlflow

# Search across runs in an experiment
runs = mlflow.search_runs(
    experiment_names=["/Users/ifkarsyah/churn-prediction"],
    filter_string="metrics.auc_roc > 0.75",
    order_by=["metrics.auc_roc DESC"],
)

best_run = runs.iloc[0]
print(f"Best run: {best_run['run_id']}")
print(f"Best AUC: {best_run['metrics.auc_roc']:.4f}")
print(f"Params: n_estimators={best_run['params.n_estimators']}")

# Get the full run object for the model
best_run_id = best_run["run_id"]
print(f"Run URL: {best_run['tags.mlflow.runName']}")
```

This pattern is useful in pipelines — automatically select the best model for promotion.

## Model Registry

The **Model Registry** is a centralized model store with **lifecycle stages**: `None` → `Staging` → `Production` → `Archived`. Register a trained model from a run, promote it through stages after validation, and deploy for serving.

Code block — registering and promoting a model:

```python
import mlflow
from mlflow.tracking import MlflowClient

# Register the best run's model
best_run_id = best_run["run_id"]
model_uri = f"runs:/{best_run_id}/model"

registered = mlflow.register_model(
    model_uri=model_uri,
    name="churn-prediction-model",
)
print(f"Registered version: {registered.version}")

# Transition to Staging (for validation)
client = MlflowClient()
client.transition_model_version_stage(
    name="churn-prediction-model",
    version=registered.version,
    stage="Staging",
)

# After validation passes, promote to Production
client.transition_model_version_stage(
    name="churn-prediction-model",
    version=registered.version,
    stage="Production",
)

# Query Production model
prod_model = mlflow.pyfunc.load_model("models:/churn-prediction-model/Production")
print(f"Production model loaded")
```

The Model Registry keeps a history of all versions and stages — full auditability for compliance.

## Loading a Model for Batch Inference

Show loading the Production model from the registry and applying it to a Gold feature table as a **Spark UDF**. This bridges Part 5 to Part 6.

Code block — batch inference with registered model:

```python
import mlflow.pyfunc

# Load Production model as a Spark UDF (distributed inference)
model_udf = mlflow.pyfunc.spark_udf(
    spark,
    model_uri="models:/churn-prediction-model/Production",
    result_type="double",  # model outputs a single float (probability)
)

# Apply to today's feature table
feature_cols = [
    "event_count_30d", "active_days_30d", "days_since_last_event",
    "purchase_count_30d", "account_age_days", "rolling_7d_events"
]

predictions = (
    spark.table("main_catalog.gold.user_features")
    .filter("feature_date = current_date()")
    .withColumn(
        "churn_probability",
        model_udf(*[F.col(c) for c in feature_cols])
    )
)

predictions.select("user_id", "churn_probability").write \
    .mode("overwrite") \
    .saveAsTable("main_catalog.gold.churn_predictions")
```

`mlflow.pyfunc.spark_udf()` loads the model once and applies it in parallel across all Spark executors — efficient distributed inference.

## Key Takeaways

- **MLflow on Databricks** is fully managed — no server setup; tracking is built-in
- A **run** captures params, metrics, and artifacts for one training execution; an **experiment** groups related runs
- **mlflow.autolog()** handles boilerplate for sklearn/XGBoost/LightGBM; still log custom metrics explicitly
- **Artifacts** (plots, configs, data samples) are logged alongside runs for inspection and debugging
- The **Model Registry** tracks lifecycle stages: `Staging` (under validation) → `Production` (serving) → `Archived` (retired)
- **mlflow.pyfunc.spark_udf()** loads a registered model as a Spark UDF for distributed batch inference

Next: ML Serving and Workflows — batch and real-time model deployment, and orchestrating the full pipeline end-to-end with Databricks Workflows.
