---
title: "Kubernetes Series, Part 3: Workload Patterns for Data Engineering"
description: "StatefulSets, Jobs, CronJobs, and DaemonSets — the right workload type for each data engineering use case."
pubDate: 2026-02-22
author: "ifkarsyah"
domain: "Infrastructure"
stack: ["Kubernetes"]
---

## The Four Workload Types

Kubernetes provides four primary workload types, each suited to different patterns:

1. **Deployment** — long-running, stateless services (Kafka Connect, REST APIs)
2. **StatefulSet** — long-running, stateful services with stable identity (Kafka brokers, ZooKeeper)
3. **Job** — finite work that runs to completion, then stops (Spark batch jobs, data imports)
4. **CronJob** — periodic scheduled work (nightly ETL, hourly backfills)

Choosing the right type prevents subtle bugs: using a Deployment for stateful work can cause data loss; using a Job for a service wastes cluster resources with unnecessary restart attempts.

## StatefulSets: Ordered, Stateful Services

A **StatefulSet** manages Pods with stable, ordinal identities: `kafka-0`, `kafka-1`, `kafka-2`. Unlike a Deployment where Pods are interchangeable, a StatefulSet Pod's name and storage are stable across restarts.

This is critical for Kafka: brokers need a stable broker ID, which is typically derived from the Pod ordinal. If `kafka-0` restarts and becomes `kafka-1`, the cluster breaks.

A StatefulSet also binds each Pod to its own PersistentVolumeClaim, creating a one-to-one relationship. When `kafka-0` is recreated, it mounts the same PVC it had before, accessing all its stored log data.

StatefulSets also enforce **ordered startup and shutdown**: Pods are created in order (0, then 1, then 2), and terminated in reverse (2, then 1, then 0). For systems like Kafka where brokers need to coordinate, this ordering prevents cascading failures during restarts.

A StatefulSet manifest (simplified):

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: kafka
spec:
  serviceName: kafka-headless  # required for StatefulSets
  replicas: 3
  selector:
    matchLabels:
      app: kafka
  template:
    metadata:
      labels:
        app: kafka
    spec:
      containers:
      - name: kafka
        image: confluentinc/cp-kafka:7.5.0
        env:
        - name: KAFKA_BROKER_ID
          valueFrom:
            fieldRef:
              fieldPath: metadata.name  # "kafka-0", "kafka-1", etc.
        - name: KAFKA_LOG_DIRS
          value: /var/lib/kafka/data
        volumeMounts:
        - name: kafka-data
          mountPath: /var/lib/kafka/data
  volumeClaimTemplates:
  - metadata:
      name: kafka-data
    spec:
      accessModes: ["ReadWriteOnce"]
      storageClassName: fast-ssd
      resources:
        requests:
          storage: 100Gi
```

The `volumeClaimTemplates` section creates a PVC for each replica. `kafka-0` gets `kafka-data-0`, `kafka-1` gets `kafka-data-1`, etc.

**When to use StatefulSet:** Kafka, ZooKeeper, Cassandra, databases, or any service where Pods need stable identity and persistent storage.

## Jobs: Finite Batch Work

A **Job** manages one or more Pods that run until they succeed (exit code 0). When all Pods succeed, the Job is marked complete. If a Pod fails, the Job launches a replacement (up to `backoffLimit` times), then gives up.

Use Jobs for Spark batch jobs, data import scripts, backfill jobs — anything with a defined completion point.

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: spark-batch-job
spec:
  backoffLimit: 3  # retry up to 3 times
  completions: 1  # how many Pods must succeed
  parallelism: 1  # how many Pods run in parallel
  template:
    spec:
      containers:
      - name: spark
        image: my-spark-image:3.4.0
        command: ["/opt/spark/bin/spark-submit", "--master", "k8s://...", "/app/job.py"]
      restartPolicy: Never  # don't restart Pods (Job will launch a new one)
```

**completions** and **parallelism** control how many Pods run:
- `completions: 10, parallelism: 3` — run 10 Pods total, at most 3 in parallel (useful for distributed jobs)
- `completions: 1, parallelism: 1` — run 1 Pod, wait for it to complete (typical for single-task jobs)

If the Pod fails, the Job launches another one (up to `backoffLimit`). If you want to retry a Spark job because it failed due to a transient error (network timeout), increase `backoffLimit`.

**When to use Job:** Batch Spark jobs, data imports, backfills, any finite work with a clear completion point.

## CronJobs: Scheduled Pipelines

A **CronJob** is a wrapper around a Job with a cron schedule. It creates a Job on the specified schedule, allowing you to run periodic data pipelines without a separate scheduler.

```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: nightly-etl
spec:
  schedule: "0 2 * * *"  # cron: 02:00 UTC every day
  concurrencyPolicy: Forbid  # don't run another job if the previous one is still running
  jobTemplate:
    spec:
      template:
        spec:
          containers:
          - name: etl
            image: my-etl-image:latest
            command: ["/app/etl.py"]
          restartPolicy: Never
```

**concurrencyPolicy** controls behavior if a scheduled time arrives while the previous job is still running:
- `Forbid` — skip the run (recommended for data pipelines to avoid duplicate runs)
- `Allow` — run both jobs in parallel (rarely used for data workloads)
- `Replace` — terminate the previous job and start a new one (dangerous; can lose data)

**startingDeadlineSeconds** (optional) specifies how late the Job can start. If the cluster was down during a scheduled time and comes back up 30 minutes later, the Job will run if `startingDeadlineSeconds` is at least 30 minutes (1800 seconds).

```yaml
spec:
  startingDeadlineSeconds: 3600  # allow up to 1 hour late
```

**When to use CronJob:** Nightly ETL, hourly ingestion, weekly reports — any periodic pipeline.

## DaemonSets: Running on Every Node

A **DaemonSet** ensures a Pod runs on every (or selected) node in the cluster. Unlike Deployments and StatefulSets where you specify replica count, a DaemonSet runs one Pod per node automatically.

Use DaemonSets for cluster-wide agents: log collectors, monitoring agents, security tools.

For data engineering, DaemonSets are less common, but you might use one to run a local Spark shuffle service or metric exporter on every node:

```yaml
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: shuffle-service
spec:
  selector:
    matchLabels:
      app: shuffle-service
  template:
    metadata:
      labels:
        app: shuffle-service
    spec:
      containers:
      - name: shuffle
        image: my-shuffle-service:1.0
        ports:
        - containerPort: 7337
```

## Deployments: Long-Running Services

**Deployment** is the default workload type for long-running services. It maintains a stable number of replicas, performs rolling updates, and has no ordering guarantees (unlike StatefulSet).

For data workloads, use Deployments for:
- Kafka Connect workers (stateless consumer of Kafka topics)
- REST APIs (Spark History Server, Flink REST API)
- Custom processors that consume from Kafka and write to a database (as long as they are stateless)

A Deployment scales horizontally: if you have 3 replicas and one crashes, it is replaced. You can manually scale (`kubectl scale deployment kafka-connect --replicas 5`) or use autoscaling (Part 6).

## Decision Matrix: Which Workload Type?

| Use Case | Workload Type | Why |
|----------|---------------|-----|
| Kafka brokers | StatefulSet | Need stable broker ID, ordered startup, PVC per broker |
| ZooKeeper cluster | StatefulSet | Stable node identity, persistent quorum |
| Spark batch job | Job | Finite work with completion point |
| Flink session cluster | Deployment | Long-running service, stateless from pod's perspective (state in object storage) |
| Nightly data ingestion | CronJob | Scheduled, periodic work |
| Kafka Connect workers | Deployment | Long-running, stateless consumers |
| Scheduled backfill Spark job | CronJob | Periodic, finite work |
| Prometheus metrics exporter | DaemonSet | Run on every node |
| Spark on Kubernetes Operator | Deployment | Manages SparkApplication CRDs (the Operator itself is long-running) |

## Key Takeaways

- **StatefulSets** provide stable Pod identity and PVC binding; use for stateful services like Kafka
- **Jobs** run to completion; use for batch work like Spark jobs
- **CronJobs** schedule periodic Jobs; use for nightly ETL or hourly ingestion
- **Deployments** are for long-running stateless services
- **DaemonSets** run one Pod per node; rarely used for data workloads
- Choosing the right type prevents bugs and resource waste

**Next:** [Part 4 — Running Spark on Kubernetes](/blog/kubernetes-series-4-spark-on-k8s)
