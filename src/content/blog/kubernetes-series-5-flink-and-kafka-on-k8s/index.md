---
title: "Kubernetes Series, Part 5: Running Flink and Kafka on Kubernetes"
description: "Deploying Flink with the Flink Kubernetes Operator and Kafka with Strimzi — the streaming stack on K8s."
pubDate: 2026-02-22
author: "ifkarsyah"
domain: "Infrastructure"
stack: ["Kubernetes"]
---

## Two Operators, One Streaming Platform

For stateful distributed systems like Flink and Kafka, manually managing Pods is error-prone. **Operators** are Kubernetes controllers that watch Custom Resources and automate complex operational tasks (restarts, upgrades, scaling, configuration changes).

The **Flink Kubernetes Operator** and **Strimzi** (Kafka Operator) are production-grade tools that let you manage Flink clusters and Kafka clusters declaratively via Kubernetes resources.

## Flink on Kubernetes: Deployment Modes

Flink can run on K8s in two deployment modes:

**Session Mode:**
- Deploy a long-running Flink cluster with JobManager and TaskManagers
- Submit multiple jobs to the same cluster
- Lightweight: multiple jobs share resources
- Lower isolation: a runaway job can affect others
- Use for: dev/test environments, many small jobs

**Application Mode:**
- Each job gets its own dedicated Flink cluster
- Cluster is created when the job starts, torn down when it completes
- Strong isolation: each job has dedicated resources
- Higher overhead: cluster startup per job
- Use for: production, resource-sensitive workloads, CI/CD integration

## The Flink Kubernetes Operator

Install the Flink Kubernetes Operator:

```bash
helm repo add flink-operator-repo https://archive.apache.org/dist/flink/flink-kubernetes-operator-0.7.0/
helm install flink-operator flink-operator-repo/flink-kubernetes-operator \
  --namespace flink-operator --create-namespace
```

Deploy a session cluster with a `FlinkDeployment` resource:

```yaml
apiVersion: flink.apache.org/v1beta1
kind: FlinkDeployment
metadata:
  name: flink-cluster
spec:
  image: flink:1.17
  flinkVersion: v1_17
  serviceAccount: flink-operator
  jobManager:
    resource:
      memory: "4g"
      cpu: 2
  taskManager:
    resource:
      memory: "8g"
      cpu: 4
    replicas: 3
  flinkConfiguration:
    taskmanager.numberOfTaskSlots: "4"
    state.backend: filesystem
    state.checkpoints.dir: s3://my-bucket/checkpoints/
    state.savepoints.dir: s3://my-bucket/savepoints/
    restart-strategy: fixed-delay
    restart-strategy.fixed-delay.attempts: 3
    restart-strategy.fixed-delay.delay: 30s
```

The Operator creates:
- A Deployment for the JobManager (1 replica)
- A Deployment for TaskManagers (3 replicas, configurable)
- Services for JobManager and TaskManager communication

Submit a job to the session cluster:

```bash
kubectl port-forward svc/flink-cluster-jobmanager 8081:8081
flink run -t kubernetes \
  -Dkubernetes.cluster.id=flink-cluster \
  -Dkubernetes.namespace=default \
  my-flink-job.jar
```

Or submit an application-mode job directly with a `FlinkDeployment`:

```yaml
apiVersion: flink.apache.org/v1beta1
kind: FlinkDeployment
metadata:
  name: my-flink-job
spec:
  image: my-flink-image:1.0
  flinkVersion: v1_17
  mode: application
  job:
    jarURI: s3://my-bucket/my-flink-job.jar
    args: ["--param", "value"]
    parallelism: 10
    upgradeMode: savepoint  # use savepoint on upgrade
  flinkConfiguration:
    state.backend: filesystem
    state.checkpoints.dir: s3://my-bucket/checkpoints/
    restart-strategy: fixed-delay
    restart-strategy.fixed-delay.attempts: 10
    restart-strategy.fixed-delay.delay: 10s
```

The Operator will manage the job lifecycle: create a cluster, submit the job, checkpoint periodically, and restart on failure.

## Flink Checkpointing and State

Flink's strength is exactly-once semantics: even if task managers crash, state is preserved via checkpoints. Configure checkpointing in `flink-conf.yaml` or `FlinkDeployment`:

```yaml
flinkConfiguration:
  state.backend: rocksdb
  state.backend.rocksdb.checkpoint.transfer.thread.num: 4
  state.checkpoints.dir: s3://my-bucket/checkpoints/
  state.savepoints.dir: s3://my-bucket/savepoints/
  execution.checkpointing.interval: 60s
  execution.checkpointing.mode: EXACTLY_ONCE
```

**state.backend:**
- `filesystem` — checkpoint to a PVC or S3; slower, simpler setup
- `rocksdb` — local RocksDB database + remote checkpoint storage; faster, more complex

**Savepoints** are explicit checkpoints you can create manually (for upgrades, debugging):

```bash
kubectl exec flink-cluster-jobmanager-0 -- flink savepoint \
  <job-id> s3://my-bucket/savepoints/my-savepoint
```

When upgrading a Flink job, trigger a savepoint, stop the job, update the image/config, and restore from the savepoint:

```yaml
spec:
  job:
    parallelism: 20  # updated
  upgradeMode: savepoint  # the Operator handles savepoint + restore
```

## Kafka on Kubernetes with Strimzi

**Strimzi** is the standard way to run Kafka on K8s. It provides Custom Resources for Kafka clusters, topics, and users, abstracting away the complexity of managing brokers, ZooKeeper, and replication.

Install Strimzi:

```bash
helm repo add strimzi https://strimzi.io/charts
helm install strimzi-operator strimzi/strimzi-kafka-operator \
  --namespace kafka --create-namespace
```

Deploy a 3-broker Kafka cluster with KRaft (no ZooKeeper):

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: kafka-cluster
spec:
  kafka:
    version: 3.6.0
    replicas: 3
    listeners:
    - name: bootstrap
      port: 9092
      type: internal
      tls: false
    config:
      offsets.topic.replication.factor: 3
      transaction.state.log.replication.factor: 3
      default.replication.factor: 3
      min.insync.replicas: 2
    storage:
      type: persistent-claim
      class: fast-ssd
      size: 100Gi
  entityOperator:
    topicOperator: {}
    userOperator: {}
```

The Operator creates a 3-broker Kafka StatefulSet and manages coordination automatically.

Declare a topic via `KafkaTopic`:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: events
spec:
  partitions: 10
  replicationFactor: 3
  config:
    retention.ms: 604800000  # 7 days
    compression.type: snappy
```

Declare a user with SASL authentication:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: flink-user
spec:
  authentication:
    type: scram-sha-512
  authorization:
    type: simple
    acls:
    - resource:
        type: topic
        name: events
      operations: [Read, Write]
    - resource:
        type: group
        name: flink-consumer-group
      operations: [Read]
```

Strimzi stores credentials as Kubernetes Secrets. Access them in your Flink job:

```bash
kubectl get secret flink-user -o jsonpath='{.data.password}' | base64 -d
```

## Connecting Flink to Kafka on Kubernetes

In a Flink application, consume from Kafka deployed via Strimzi:

```java
StreamExecutionEnvironment env = StreamExecutionEnvironment.getExecutionEnvironment();

Properties props = new Properties();
props.setProperty("bootstrap.servers", "kafka-cluster-kafka-bootstrap.kafka.svc.cluster.local:9092");
props.setProperty("group.id", "flink-consumer-group");
props.setProperty("security.protocol", "SASL_PLAINTEXT");
props.setProperty("sasl.mechanism", "SCRAM-SHA-512");
props.setProperty("sasl.username", "flink-user");
props.setProperty("sasl.password", System.getenv("KAFKA_PASSWORD"));

FlinkKafkaConsumer<String> kafkaSource = new FlinkKafkaConsumer<>(
  "events",
  new SimpleStringSchema(),
  props
);

DataStream<String> stream = env.addSource(kafkaSource);
// process...
stream.addSink(new FlinkKafkaProducer<>(...));

env.execute("Flink-Kafka Pipeline");
```

The service DNS `kafka-cluster-kafka-bootstrap.kafka.svc.cluster.local:9092` resolves to the Kafka brokers. If Flink and Kafka are in different namespaces, use `kafka-cluster-kafka-bootstrap.kafka.svc.cluster.local`.

## Complete Example: Flink + Kafka Pipeline on K8s

1. Deploy Kafka:

```yaml
apiVersion: kafka.strimzi.io/v1beta2
kind: Kafka
metadata:
  name: kafka-cluster
  namespace: kafka
spec:
  kafka:
    version: 3.6.0
    replicas: 3
    storage:
      type: persistent-claim
      class: fast-ssd
      size: 100Gi
    # ... (as above)
```

2. Create a topic and user:

```yaml
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaTopic
metadata:
  name: orders
  namespace: kafka
spec:
  partitions: 10
  replicationFactor: 3
---
apiVersion: kafka.strimzi.io/v1beta2
kind: KafkaUser
metadata:
  name: flink-app
  namespace: kafka
spec:
  authentication:
    type: scram-sha-512
  authorization:
    type: simple
    acls:
    - resource:
        type: topic
        name: orders
      operations: [Read, Write]
    - resource:
        type: group
        name: order-processor-group
      operations: [Read]
```

3. Deploy Flink application:

```yaml
apiVersion: flink.apache.org/v1beta1
kind: FlinkDeployment
metadata:
  name: order-processor
  namespace: flink
spec:
  image: my-flink-app:1.0
  mode: application
  job:
    jarURI: s3://my-bucket/order-processor.jar
    parallelism: 20
  flinkConfiguration:
    state.backend: rocksdb
    state.checkpoints.dir: s3://my-bucket/checkpoints/
```

The Flink job connects to `kafka-cluster-kafka-bootstrap.kafka.svc.cluster.local:9092` and consumes from the `orders` topic with SCRAM authentication (credentials injected via environment variables from the Kubernetes Secret).

## Key Takeaways

- **Flink Kubernetes Operator** manages FlinkDeployments and simplifies cluster lifecycle
- **Session mode** shares a cluster across jobs; **application mode** isolates each job
- **Checkpointing** to S3 ensures exactly-once semantics and job recoverability
- **Strimzi** manages Kafka clusters, topics, and users as Kubernetes resources
- **Service DNS** (`kafka-cluster-kafka-bootstrap.kafka.svc.cluster.local`) enables cross-Pod communication
- Flink and Kafka Operators together provide a complete, declarative streaming platform

**Next:** [Part 6 — Production Operations](/blog/kubernetes-series-6-production)
