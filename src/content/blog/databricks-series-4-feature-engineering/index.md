---
title: "Databricks Series, Part 4: Feature Engineering at Scale"
description: "Databricks Feature Store, FeatureEngineeringClient, FeatureLookup, training sets, and eliminating training-serving skew."
pubDate: 2024-11-03
author: "ifkarsyah"
tags: ["Databricks", "Data Engineering", "MLOps"]
image:
  src: ./databricks-series.png
  alt: "Databricks Feature Engineering"
---

## The Training-Serving Skew Problem

**Training-serving skew** is a silent killer in ML systems. Without a feature store, the same feature (e.g., "30-day purchase count") is computed by **two separate code paths**: one in the training pipeline and one in the scoring/serving pipeline. Subtle differences in logic—timezone handling, null treatment, aggregation window boundaries—produce different values. The model was trained on features it never sees in production. Performance silently degrades, blame shifts between teams, and nobody knows why.

Beyond skew, organizations face **feature discovery chaos**: multiple teams independently recompute the same features with slight variations. A junior engineer spends weeks computing a feature that already exists elsewhere, buried in someone else's notebook.

And **development complexity**: ML engineers must know not just *what* features they need, but *how* to compute them. They can't simply request "the 30-day purchase count for customer 42"—they must write the aggregation, handle edge cases, ensure the window is exactly right.

**Databricks Feature Store** solves all three problems.

## What Databricks Feature Store Provides

**Databricks Feature Store** is a centralized registry for ML features. It ensures that the same feature computation logic is used in training and serving, eliminating skew. It enables feature discovery and reuse across teams. It simplifies client code: callers request features by name and lookup key, not by computation logic.

Key properties:

- **Feature tables** are Delta tables with a declared primary key
- **Features are computed once, stored once, and reused** for both training and serving
- The **Feature Store embeds feature metadata** inside MLflow model artifacts (`feature_spec.yaml`)
- **`score_batch` reconstructs the exact same joins** at inference time using that metadata—no feature-computation code needed
- **Lineage is automatic**: Unity Catalog links models to the feature tables they depend on

There are two Feature Store APIs: the legacy `FeatureStoreClient` (deprecated, `databricks.feature_store`, 2-level namespace) and the current `FeatureEngineeringClient` (Unity Catalog-native, `catalog.schema.table`). Always use the current `FeatureEngineeringClient` for new work.

## Setting Up the Feature Engineering Client

Feature Store is pre-installed in Databricks Runtime ML (DBR 13.3 LTS ML recommended). Initialize it:

Code block — setup:

```python
# Install (pre-installed in DBR 13.3+ ML runtime)
%pip install databricks-feature-engineering
dbutils.library.restartPython()

from databricks.feature_engineering import FeatureEngineeringClient

fe = FeatureEngineeringClient()

# Create the Unity Catalog namespace for feature tables
spark.sql("CREATE CATALOG IF NOT EXISTS ml")
spark.sql("CREATE SCHEMA IF NOT EXISTS ml.user_features")
```

Feature tables live in a `catalog.schema.table` 3-level namespace managed by Unity Catalog. This ensures governance, lineage tracking, and cross-workspace sharing.

## Computing Features from Silver

Feature computation is pure Spark: read from Silver, apply transformations (groupBy, aggregations, window functions, joins), produce a DataFrame. The feature computation logic is **separate from the Feature Store registration**—first compute, then register.

Code block — compute behavioral features:

```python
from pyspark.sql import functions as F

# Read from Silver with partition pruning
events = (
    spark.table("main_catalog.clean.events")
    .filter(F.col("event_ts") >= F.date_sub(F.current_date(), 30))
)

# Compute 30-day behavioral features per user
user_features_df = (
    events
    .groupBy("user_id")
    .agg(
        F.count("*").alias("event_count_30d"),
        F.countDistinct(F.to_date("event_ts")).alias("active_days_30d"),
        F.max("event_ts").alias("last_event_ts"),
        F.sum((F.col("event_type") == "purchase").cast("int")).alias("purchase_count_30d"),
    )
    .withColumn(
        "days_since_last_event",
        F.datediff(F.current_date(), F.to_date("last_event_ts"))
    )
)

user_features_df.show(5)
```

This DataFrame is your input to Feature Store. The Feature Store takes it from here.

## Creating and Writing a Feature Table

Register the DataFrame as a **feature table** with `fe.create_table()`. Declare the **primary key**—the column(s) that uniquely identify a row. For subsequent updates, use `fe.write_table(mode='merge')` which upserts by primary key (insert new rows, update existing rows with matching key).

Code block — create and write feature table:

```python
# First time: create the feature table with primary key
fe.create_table(
    name="ml.user_features.behavioral",
    primary_keys=["user_id"],
    df=user_features_df,
    description="30-day behavioral features per user: purchase count, active days, etc.",
    tags={"team": "ml-platform", "domain": "engagement"},
)

# Subsequent runs: upsert new data (merge = insert or update by primary key)
fe.write_table(
    name="ml.user_features.behavioral",
    df=user_features_df,
    mode="merge",
)
```

`mode='merge'` is the only write mode Feature Store provides. It upserts: rows with a `user_id` that already exists are updated; new `user_id` values are inserted. This is unlike raw Delta MERGE—the Feature Store handles the logic automatically.

## Training with FeatureLookup and create_training_set

This is where Feature Store creates value. Instead of training code that computes features, you declare **which features you need** and **where to find them** using `FeatureLookup`. The Feature Store performs the joins automatically.

Code block — full training workflow:

```python
from databricks.feature_engineering import FeatureLookup
import mlflow
import mlflow.sklearn
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import roc_auc_score

# training_df: only needs lookup keys + label (user_id, label)
training_df = spark.table("main_catalog.gold.churn_labels")

# Declare which features to use and where to find them
feature_lookups = [
    FeatureLookup(
        table_name="ml.user_features.behavioral",
        feature_names=["event_count_30d", "active_days_30d",
                       "days_since_last_event", "purchase_count_30d"],
        lookup_key="user_id",  # join key in training_df
    ),
]

with mlflow.start_run(run_name="churn-model-v1"):
    # Create training set: join features from Feature Store onto training_df
    training_set = fe.create_training_set(
        df=training_df,
        feature_lookups=feature_lookups,
        label="label",
        exclude_columns=["user_id"],  # drop join key from features
    )

    # Materialize as Pandas for sklearn
    pdf = training_set.load_df().toPandas()
    X = pdf.drop(columns=["label"])
    y = pdf["label"]

    X_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)

    # Train
    model = GradientBoostingClassifier(n_estimators=100, max_depth=4)
    model.fit(X_train, y_train)

    # Log metrics
    auc = roc_auc_score(y_test, model.predict_proba(X_test)[:, 1])
    mlflow.log_metric("auc_roc", auc)

    # Log model WITH feature lineage (fe.log_model, not mlflow.sklearn.log_model)
    fe.log_model(
        model=model,
        artifact_path="model",
        flavor=mlflow.sklearn,
        training_set=training_set,  # embeds feature_spec.yaml
        registered_model_name="ml.user_features.churn_model",
    )
```

**Critical:** use `fe.log_model()` (from Feature Store), not `mlflow.sklearn.log_model()`. `fe.log_model()` embeds a `feature_spec.yaml` sidecar inside the MLflow artifact. This sidecar records **every feature table, feature name, and lookup key** used in training. This metadata is the link between training and serving.

## Batch Scoring with score_batch

At inference time, `fe.score_batch()` reconstructs the exact same joins without any feature-computation code. It reads `feature_spec.yaml` from the registered model, issues the same `FeatureLookup` joins against the current Feature Store data, assembles the feature vector, and scores.

Code block — batch scoring:

```python
# scoring_df only needs lookup keys: user_id
scoring_df = spark.table("main_catalog.gold.users_to_score").select("user_id")

# Automatically fetches features from Feature Store + applies model
predictions = fe.score_batch(
    model_uri="models:/ml.user_features.churn_model/Production",
    df=scoring_df,
)

# predictions has: user_id, feature columns, prediction
predictions.select("user_id", "prediction").write \
    .mode("overwrite") \
    .saveAsTable("main_catalog.gold.churn_predictions")
```

Notice: the scoring job does **not** compute features. It only provides `user_id`. Feature Store handles the rest.

Also note: if `scoring_df` already contains a column named `event_count_30d` (or any feature name), that value is used instead of querying Feature Store. This is useful for injecting real-time computed values—override a stale feature with a fresh one computed moments before inference.

## Feature Lineage in Unity Catalog

When you call `fe.log_model(training_set=training_set)`, Unity Catalog automatically records the dependency: the trained model depends on the feature tables referenced in the `training_set`. This lineage is visible in Catalog Explorer under the model's lineage tab.

No extra configuration needed. This automatic lineage:

- Documents what data each model was trained on
- Enables impact analysis: "if we change the behavioral feature table, which models might be affected?"
- Supports compliance and auditing: full provenance for ML models

For features that cannot be pre-materialized (e.g., real-time request context), use **`FeatureFunction`**—Python UDFs registered in Unity Catalog that are computed on-demand during training/scoring. This is beyond the scope here, but know it exists for hybrid scenarios.

## Key Takeaways

- **Training-serving skew** is eliminated: features are computed once, stored once, reused in training and serving
- `FeatureEngineeringClient` (current) is preferred over `FeatureStoreClient` (deprecated, legacy)
- **Feature tables** are Delta tables with a declared **primary key**; `fe.write_table(mode='merge')` upserts by key
- `FeatureLookup` + `fe.create_training_set()` declare which features you need; Feature Store performs the joins as Spark operations
- **`fe.log_model(training_set=...)`** embeds `feature_spec.yaml` in the artifact—`score_batch` uses this metadata to reconstruct joins automatically
- **Automatic lineage**: Unity Catalog links models to feature tables when `fe.log_model` is used—no extra code

Next: Machine Learning with MLflow — tracking experiments, logging models, and managing the model lifecycle on Databricks.
