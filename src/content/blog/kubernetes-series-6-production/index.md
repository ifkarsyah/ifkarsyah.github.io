---
title: "Kubernetes Series, Part 6: Production Operations"
description: "Resource quotas, autoscaling (HPA/KEDA), monitoring with Prometheus and Grafana, and cluster cost management for data platforms."
pubDate: 2026-02-22
author: "ifkarsyah"
tags: ["Kubernetes", "Data Engineering", "DevOps"]
---

## Resource Quotas and LimitRanges

In a shared cluster, multiple teams run workloads. Without quotas, one team's runaway job can consume all CPU and memory, starving other teams. **ResourceQuota** sets hard limits on total resource usage per namespace.

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: data-platform
---
apiVersion: v1
kind: ResourceQuota
metadata:
  name: data-platform-quota
  namespace: data-platform
spec:
  hard:
    requests.cpu: "100"      # total CPU requests across all Pods
    requests.memory: "500Gi"  # total memory requests
    limits.cpu: "200"        # total CPU limits
    limits.memory: "1000Gi"  # total memory limits
    pods: "200"              # max number of Pods
    services: "10"
```

When a Pod requests resources, K8s checks if the quota permits it. If not, the Pod is rejected with `Quotas exceeded`.

**LimitRange** sets default and maximum resource requests/limits per Pod, preventing developers from creating tiny or gigantic Pods:

```yaml
apiVersion: v1
kind: LimitRange
metadata:
  name: data-platform-limits
  namespace: data-platform
spec:
  limits:
  - max:
      cpu: "16"
      memory: "64Gi"
    min:
      cpu: "100m"
      memory: "128Mi"
    default:
      cpu: "2"
      memory: "2Gi"
    defaultRequest:
      cpu: "1"
      memory: "1Gi"
    type: Pod
```

Every Pod in the namespace inherits these defaults if not explicitly set.

## Autoscaling

Manual scaling is tedious. Kubernetes provides three autoscaling mechanisms:

### Horizontal Pod Autoscaler (HPA)

HPA scales the number of Pod replicas based on CPU or memory utilization.

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: kafka-connect-hpa
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: kafka-connect
  minReplicas: 2
  maxReplicas: 20
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

HPA monitors the average CPU utilization across all replicas. When utilization exceeds 70%, it scales up (adding replicas). When it drops below 70%, it scales down. This is useful for Kafka Connect workers, REST APIs, or stateless processors.

### Vertical Pod Autoscaler (VPA)

VPA adjusts Pod resource requests/limits based on actual usage observed over time.

```yaml
apiVersion: autoscaling.k8s.io/v1
kind: VerticalPodAutoscaler
metadata:
  name: spark-vpa
spec:
  targetRef:
    apiVersion: "apps/v1"
    kind: Deployment
    name: spark-driver
  updatePolicy:
    updateMode: "Auto"
```

VPA watches metrics, learns typical resource usage, and recommends or automatically adjusts requests/limits. Use this to right-size executors and drivers without manual tuning.

### KEDA: Event-Driven Autoscaling

**Kubernetes Event-driven Autoscaling (KEDA)** scales workloads based on custom metrics: Kafka consumer lag, queue depth, HTTP request rate, or custom application metrics.

For data workloads, scaling based on Kafka consumer lag is common:

```yaml
apiVersion: keda.sh/v1alpha1
kind: ScaledObject
metadata:
  name: flink-scaler
spec:
  scaleTargetRef:
    name: flink-cluster-taskmanager
  minReplicaCount: 1
  maxReplicaCount: 50
  triggers:
  - type: kafka
    metadata:
      bootstrapServers: kafka-cluster-kafka-bootstrap:9092
      consumerGroup: flink-consumer-group
      topic: orders
      lagThreshold: "1000"  # scale up if any partition has >1000 lag
```

When Kafka consumer lag (the difference between current offset and latest offset) exceeds 1000, KEDA scales up the TaskManager replicas. As lag decreases, it scales down.

This is powerful for data pipelines: automatically allocate more resources when data is backing up, and free resources when caught up.

## Monitoring the Data Platform

The standard monitoring stack is **Prometheus** (metrics collection) + **Grafana** (visualization) + **AlertManager** (alerting).

Deploy Prometheus with the **Prometheus Operator**:

```bash
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm install prometheus prometheus-community/kube-prometheus-stack \
  --namespace monitoring --create-namespace
```

This deploys:
- **Prometheus** — scrapes metrics from targets
- **Grafana** — visualizes metrics
- **AlertManager** — sends alerts
- **Prometheus Operator** — manages Prometheus via `Prometheus` CRDs

Tell Prometheus to scrape metrics from your Flink or Spark jobs via `ServiceMonitor`:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: flink-monitoring
spec:
  selector:
    matchLabels:
      app: flink-cluster
  endpoints:
  - port: metrics
    interval: 30s
```

Key metrics to alert on for data workloads:

- **Kafka consumer lag**: `kafka_consumergroup_lag_sum > 10000` (backlog is building up)
- **Flink checkpoint failures**: `flink_taskmanager_checkpoint_num_failed_total` (state not being saved)
- **Spark executor OOM count**: custom metric tracking `OutOfMemoryError` count
- **Flink task restart rate**: `flink_jobmanager_job_task_restart_total` (jobs unstable)

Set up alerts in Prometheus:

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: data-platform-alerts
spec:
  groups:
  - name: data.rules
    interval: 30s
    rules:
    - alert: KafkaLagHigh
      expr: kafka_consumergroup_lag_sum > 10000
      for: 5m
      annotations:
        summary: "Kafka consumer lag is high ({{ $value }})"
    - alert: FlinkCheckpointFailing
      expr: rate(flink_taskmanager_checkpoint_num_failed_total[5m]) > 0
      annotations:
        summary: "Flink checkpoints are failing"
```

## Cluster Cost Management

Kubernetes clusters cost money: nodes, persistent storage, load balancers. In a shared cluster with bursty data workloads, cost can balloon quickly.

**Node Pools:** Create separate node pools for different workload types:

```yaml
# GKE example
gcloud container node-pools create gpu-pool \
  --cluster=my-cluster \
  --machine-type=n1-highmem-16 \
  --num-nodes=0 \
  --enable-autoscaling \
  --min-nodes=0 \
  --max-nodes=20

# Add node affinity to Spark executors
nodeAffinity:
  requiredDuringSchedulingIgnoredDuringExecution:
    nodeSelectorTerms:
    - matchExpressions:
      - key: cloud.google.com/gke-nodepool
        operator: In
        values: ["gpu-pool"]
```

**Spot/Preemptible Instances:** Use cheap, interruptible VMs for batch jobs:

- **GCP Preemptible** — 70% cheaper, 24-hour lifetime, can be interrupted
- **AWS Spot** — up to 90% cheaper, similar lifetime

Use Spot instances for Spark batch jobs that checkpoint frequently (so if interrupted, re-compute is fast). Avoid Spot for Kafka brokers or long-running services.

```yaml
tolerations:
- key: cloud.google.com/gke-preemptible
  operator: Equal
  value: "true"
  effect: NoSchedule
```

**Right-sizing:** Monitor actual resource usage and adjust requests/limits:

```bash
kubectl top nodes        # see node CPU/memory utilization
kubectl top pods -n flink # see pod utilization
```

Use these metrics to tune resource requests, avoiding over-provisioning (paying for unused capacity) and under-provisioning (OOM kills).

**Cost Attribution:** Tools like **Kubecost** or **OpenCost** break down costs per namespace, Pod, or workload:

```bash
helm install kubecost kubecost/cost-analyzer \
  --namespace kubecost --create-namespace
# opens UI at kubecost service, shows costs per team/namespace
```

## Rolling Upgrades and Zero-Downtime Operations

**Upgrading Kafka (via Strimzi):**

Strimzi's Kafka Operator handles rolling broker upgrades automatically. Change the image version:

```yaml
spec:
  kafka:
    version: 3.7.0  # updated from 3.6.0
```

Apply the change. Strimzi:
1. Stops and restarts one broker at a time (in reverse ordinal order: broker-2, broker-1, broker-0)
2. Waits for the broker to re-join the cluster and catch up
3. Moves to the next broker

Clients see a few seconds of unavailability per broker, but overall the cluster remains operational.

**Upgrading a Flink Job:**

1. Trigger a savepoint:

```bash
kubectl exec flink-cluster-jobmanager-0 -- \
  flink savepoint <job-id> s3://my-bucket/savepoints/pre-upgrade
```

2. Update the `FlinkDeployment` image and set `upgradeMode: savepoint`:

```yaml
spec:
  job:
    jarURI: s3://my-bucket/new-version.jar
  upgradeMode: savepoint
  flinkConfiguration:
    state.savepoints.dir: s3://my-bucket/savepoints/pre-upgrade
```

3. The Operator stops the old job, saves state, starts the new image, and restores from the savepoint.

The job resumes from exactly where it left off — no message loss, no duplicate processing.

## Cluster Hardening Checklist

**RBAC (Role-Based Access Control):**

Grant the minimum necessary permissions. Avoid wildcards (`*`).

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: spark-driver-minimal
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["create", "delete", "get"]  # only what Spark needs
```

**Network Policies:**

Restrict which Pods can talk to Kafka brokers. By default, all Pods can communicate with all other Pods. Network policies enforce segmentation:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: kafka-access
spec:
  podSelector:
    matchLabels:
      app: kafka
  policyTypes:
  - Ingress
  ingress:
  - from:
    - namespaceSelector:
        matchLabels:
          name: flink
    ports:
    - protocol: TCP
      port: 9092
```

Only Pods in the `flink` namespace can connect to Kafka.

**Pod Security Standards:**

Enforce security policies for Pods (no privileged containers, read-only root filesystem, etc.):

```yaml
apiVersion: policy/v1beta1
kind: PodSecurityPolicy
metadata:
  name: restricted-data-workloads
spec:
  privileged: false
  allowPrivilegeEscalation: false
  requiredDropCapabilities:
    - ALL
  volumes:
    - 'configMap'
    - 'emptyDir'
    - 'projected'
    - 'secret'
    - 'downwardAPI'
    - 'persistentVolumeClaim'
  runAsUser:
    rule: 'MustRunAsNonRoot'
  seLinux:
    rule: 'MustRunAs'
  readOnlyRootFilesystem: false
```

**Audit Logging:**

Log all API requests to see who submitted which Spark job and when:

```yaml
# Enable in kube-apiserver startup flags
--audit-log-path=/var/log/kubernetes/audit.log
--audit-log-maxage=30
--audit-log-maxsize=100
```

## Key Takeaways

- **ResourceQuota** and **LimitRange** enforce fair resource sharing in multi-tenant clusters
- **HPA** scales replicas based on CPU/memory; **KEDA** scales based on custom metrics (Kafka lag)
- **Prometheus + Grafana** monitor metrics; **AlertManager** sends alerts
- **Cost management** via node pools, Spot instances, and cost attribution tools like Kubecost
- **Rolling upgrades** via Operators ensure zero-downtime deployments
- **RBAC, network policies, and PSPs** harden clusters against misuse and breaches

## The Complete Picture

You now understand Kubernetes from fundamentals (Pods, Deployments, Services) to running a production data platform (Spark, Flink, Kafka, monitoring, cost management). The journey progresses naturally:

- **Part 1** — Master the basic objects (Pods, Deployments, Services)
- **Parts 2-3** — Understand storage and workload patterns for your tools
- **Parts 4-5** — Deploy Spark, Flink, and Kafka on Kubernetes
- **Part 6** — Operationalize: monitor, scale, secure, and manage costs

From here, the next steps are:
- **Deploy a local cluster** with `minikube` or `kind` and practice Parts 1-3
- **Run a simple Spark or Flink job** on a managed cluster (GKE, EKS, AKS) using Parts 4-5
- **Set up monitoring and autoscaling** to operationalize your data platform (Part 6)

Kubernetes is a powerful platform for data engineering. It unifies container management, resource scheduling, and service discovery under a single, declarative system. With Operators for Spark, Flink, and Kafka, you can build and manage entire data platforms reliably and at scale.
