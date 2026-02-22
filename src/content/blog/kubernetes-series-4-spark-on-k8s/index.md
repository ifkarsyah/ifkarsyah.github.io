---
title: "Kubernetes Series, Part 4: Running Spark on Kubernetes"
description: "Submitting Spark jobs natively to K8s, the Spark Operator, executor resource sizing, and shuffle storage."
pubDate: 2026-02-22
author: "ifkarsyah"
tags: ["Kubernetes", "Data Engineering", "DevOps"]
---

## Spark's Kubernetes Support: A Brief History

Apache Spark added native Kubernetes support in version 2.3 (2018). Before Kubernetes, Spark ran on YARN (Hadoop's resource manager) or Mesos. The native K8s scheduler allows Spark to run directly on any Kubernetes cluster without a middleware layer.

Spark's architecture maps naturally to Kubernetes:
- **Driver** — the coordinator process running as a Kubernetes Pod
- **Executors** — worker processes running as separate Kubernetes Pods
- **kubelet** — acts as the task launcher, creating executor Pods on demand

When you submit a Spark job to a K8s cluster, the driver creates a Pod, then requests the Kubernetes scheduler to launch executor Pods with specific resource requirements.

## The Spark on Kubernetes Architecture

```
┌────────────────────────────────────────────────┐
│          Kubernetes Cluster                    │
│                                                │
│  ┌──────────────────────────────────────────┐ │
│  │          Driver Pod                      │ │
│  │  ┌──────────────────────────────────┐   │ │
│  │  │  Spark Driver                    │   │ │
│  │  │  (orchestrates job execution)    │   │ │
│  │  └──────────────────────────────────┘   │ │
│  └──────────────────────────────────────────┘ │
│           │                   │                │
│           ▼                   ▼                │
│  ┌──────────────┐     ┌──────────────┐       │
│  │Executor Pod 0│     │Executor Pod 1│  ...  │
│  │              │     │              │       │
│  │Executor 0    │     │Executor 1    │       │
│  └──────────────┘     └──────────────┘       │
│                                                │
└────────────────────────────────────────────────┘
```

The driver Pod needs a **ServiceAccount** and RBAC permissions to create and delete Pods in the cluster. A minimal service account and role binding:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: spark-driver
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: spark-driver-role
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["create", "delete", "get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: spark-driver-rolebinding
subjects:
- kind: ServiceAccount
  name: spark-driver
roleRef:
  kind: Role
  name: spark-driver-role
  apiGroup: rbac.authorization.k8s.io
```

## Submitting a Job with `spark-submit`

Use `spark-submit` with the `k8s://` master URL:

```bash
spark-submit \
  --master k8s://https://kubernetes.default.svc.cluster.local:443 \
  --deploy-mode cluster \
  --name my-spark-job \
  --conf spark.kubernetes.namespace=default \
  --conf spark.kubernetes.driver.pod.name=spark-driver \
  --conf spark.kubernetes.container.image=my-spark-image:3.4.0 \
  --conf spark.kubernetes.container.image.pullPolicy=Always \
  --conf spark.kubernetes.authenticate.driver.serviceAccountName=spark-driver \
  --conf spark.driver.cores=2 \
  --conf spark.driver.memory=4g \
  --conf spark.executor.cores=4 \
  --conf spark.executor.memory=8g \
  --conf spark.executor.instances=10 \
  s3a://my-bucket/my-job.py
```

Key configurations:

- `--master k8s://...` — the Kubernetes API server URL (defaults to `https://kubernetes.default.svc.cluster.local:443`)
- `--deploy-mode cluster` — driver runs in a Pod (not on the submit machine)
- `spark.kubernetes.container.image` — the Docker image containing Spark and your job code
- `spark.driver.cores` and `spark.driver.memory` — driver Pod resource requests
- `spark.executor.cores` and `spark.executor.memory` — executor Pod resource requests
- `spark.executor.instances` — how many executor Pods to create

The Docker image must contain Spark and your job code. Build it:

```dockerfile
FROM bitnami/spark:3.4.0
COPY my-job.py /app/my-job.py
COPY requirements.txt /app/requirements.txt
RUN pip install -r /app/requirements.txt
```

## The Spark Kubernetes Operator

Manually submitting Spark jobs with `spark-submit` works, but in production you want declarative, K8s-native job submission. The **Spark Kubernetes Operator** (part of the Apache Spark project) lets you submit jobs as Kubernetes Custom Resources.

Install it with Helm:

```bash
helm repo add spark-operator https://googlecloudplatform.github.io/spark-on-k8s-operator
helm install spark-operator spark-operator/spark-operator \
  --namespace spark-operator --create-namespace
```

Submit a job via a `SparkApplication` manifest:

```yaml
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkApplication
metadata:
  name: pi-estimation
spec:
  type: Scala
  mode: cluster
  image: gcr.io/spark-operator/spark:v3.4.0
  imagePullPolicy: IfNotPresent
  mainClass: org.apache.spark.examples.SparkPi
  mainApplicationFile: local:///opt/spark/examples/jars/spark-examples.jar
  arguments:
    - "10"
  sparkVersion: "3.4.0"
  restartPolicy:
    type: Never
  driver:
    cores: 2
    memory: 4g
    serviceAccount: spark-driver
  executor:
    cores: 4
    memory: 8g
    instances: 10
```

The Operator watches for `SparkApplication` resources and submits them to the K8s scheduler. You can also schedule them periodically:

```yaml
apiVersion: sparkoperator.k8s.io/v1beta2
kind: SparkScheduledApplication
metadata:
  name: nightly-pi-estimation
spec:
  schedule: "0 2 * * *"  # 02:00 UTC daily
  concurrencyPolicy: Forbid
  template:
    # same SparkApplication spec as above
```

Monitor via the Operator UI or Spark's history server running in a Pod.

## Executor Resource Sizing

Properly sizing executor resources is critical for performance and avoiding OOM kills.

**CPU requests vs limits:**
- `spark.kubernetes.executor.request.cores` — the reserved CPU (K8s scheduler uses this for placement)
- `spark.kubernetes.executor.limit.cores` — the maximum CPU the executor can use (K8s enforces throttling if exceeded)

Setting a CPU limit can unexpectedly throttle executors. Many production deployments set a high or unlimited limit to avoid throttling. The request is what matters for scheduling.

**Memory:**
Spark executors consume more than just `spark.executor.memory`. There is also:
- **Executor memory** — heap memory for RDDs and caches (`spark.executor.memory`)
- **Memory overhead** — off-heap memory for JVM overhead, Python processes, etc. (`spark.executor.memoryOverhead`, default 384MB or 10% of executor memory)

The total memory requested from K8s is `spark.executor.memory + spark.executor.memoryOverhead`. If you set `spark.executor.memory=8g` and `spark.executor.memoryOverhead=2g`, the Pod requests `10g` of memory from K8s.

If the Pod exceeds this limit, Kubernetes kills it with an OOM error. To diagnose:

```bash
kubectl describe pod <executor-pod>
# look for "Reason: OOMKilled"

kubectl logs <executor-pod>
# look for OutOfMemoryError in Spark logs
```

**Recommendation:** Set `spark.executor.memoryOverhead` explicitly (e.g., `2g` for large executors, `512m` for small ones) and monitor actual usage via Spark UI or metrics.

## Shuffle Storage on Kubernetes

When Spark executors shuffle data (during `groupByKey`, `join`, etc.), they write shuffle blocks to disk. Several options:

**Option 1: Local disk (default)**

Shuffle blocks are written to the executor Pod's local filesystem. If the Pod dies, the blocks are lost and must be re-computed.

Fast, simple, but not fault-tolerant. Fine for:
- Jobs that can tolerate re-computation (iterative algorithms)
- Jobs with few executor failures (stable cluster)

**Option 2: Remote Shuffle Service (Uniffle, Spark RSS)**

Shuffle data is written to a separate, long-running shuffle service. The shuffle service persists shuffle blocks across executor Pod failures, so Spark does not need to re-compute.

Deploy Uniffle on Kubernetes and configure Spark to use it:

```bash
--conf spark.shuffle.service.enabled=false \
--conf spark.shuffle.manager=org.apache.uniffle.shuffle.RssShuffleManager \
--conf spark.rss.coordinator.quorum=uniffle-coordinator:19999
```

More reliable, but adds operational complexity and cost (shuffle service infrastructure).

**Option 3: S3 shuffle storage**

Write shuffle blocks to S3 or S3-compatible storage (MinIO). Very durable, but slow — only for jobs where durability matters more than speed (backfills, one-time large exports).

**Recommendation:** Use local disk for most jobs; use Uniffle for large, critical jobs; use S3 only when durability is paramount.

## Key Takeaways

- **Spark native K8s support** maps Driver to one Pod and Executors to many Pods
- **spark-submit with `--master k8s://`** submits jobs directly to K8s
- **Spark Kubernetes Operator** provides declarative CRD-based job submission
- **Executor resource sizing** requires setting `spark.executor.memory`, `spark.executor.memoryOverhead`, and `spark.executor.cores` correctly
- **Shuffle storage** is local by default (fast, ephemeral); use Uniffle for durability or S3 for very large jobs

**Next:** [Part 5 — Running Flink and Kafka on Kubernetes](/blog/kubernetes-series-5-flink-and-kafka-on-k8s)
