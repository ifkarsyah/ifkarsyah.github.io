---
title: "Kubernetes Series, Part 1: Core Concepts"
description: "Pods, Deployments, Services, ConfigMaps, and Namespaces — the essential vocabulary every K8s user must know."
pubDate: 2026-02-22
author: "ifkarsyah"
domain: "Infrastructure"
stack: ["Kubernetes"]
---

## The Pod: Kubernetes' Atomic Unit

The **Pod** is the smallest thing you can deploy in Kubernetes. It is one or more containers that share a network namespace and storage, always scheduled together on the same node. In most cases, a Pod is a single container, but multi-container Pods are common for sidecar patterns — for example, a Kafka consumer Pod with a sidecar that syncs metrics to a monitoring system.

Pods are ephemeral: they are created, they run, and they are destroyed. They do not restart themselves. Container restarts happen inside a Pod, but when a Pod's node fails or the Pod is evicted, the Pod is gone forever. This is why we use higher-level constructs like **Deployments** to manage Pods.

A minimal Pod manifest in YAML:

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: data-processor-1
spec:
  containers:
  - name: processor
    image: myregistry.azurecr.io/data-processor:1.0.0
    resources:
      requests:
        cpu: "500m"
        memory: "512Mi"
      limits:
        cpu: "1000m"
        memory: "1Gi"
```

In practice, you almost never write Pods directly. Instead, you use **Deployments** or **StatefulSets** that manage Pods for you.

## Deployments: Declarative Pod Management

A **Deployment** is a controller that watches the desired number of Pod replicas and ensures reality matches. If you ask for 3 replicas and one Pod crashes, the Deployment automatically creates a new one.

The Deployment is the workhorse of Kubernetes — use it for most stateless services: REST APIs, microservices, Kafka Connect workers, and similar workloads.

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: spark-driver
spec:
  replicas: 3
  selector:
    matchLabels:
      app: spark-driver
  template:
    metadata:
      labels:
        app: spark-driver
    spec:
      containers:
      - name: driver
        image: myregistry.azurecr.io/spark-driver:3.4.0
        env:
        - name: SPARK_MASTER
          value: "k8s://https://kubernetes.default.svc.cluster.local:443"
```

When you apply this manifest, Kubernetes creates 3 Pods. If one Pod crashes, the Deployment controller detects the mismatch and launches a replacement. If you update the image, the Deployment performs a **rolling update** — terminating old Pods and launching new ones with the new image, ensuring zero downtime (when configured with readiness probes).

**Rolling updates** are key for production data workloads: you can deploy a new Kafka version, a bug fix in your Spark job, or a configuration change without stopping traffic.

## Services: Stable Network Endpoints

Pod IPs are unstable — when a Pod restarts, it gets a new IP. If you have a Spark driver at `10.244.0.5` and it restarts, the new Pod gets `10.244.1.2`. How do Spark executors find the driver?

A **Service** provides a stable DNS name and IP address that routes to a set of Pods. Services are how Kubernetes provides service discovery.

Three types of Services are most common:

- **ClusterIP** (default) — exposes the Service on a stable IP reachable only inside the cluster. DNS: `service-name.namespace.svc.cluster.local`. Use for internal data pipelines: Kafka brokers, Spark driver, Flink task manager.
- **NodePort** — exposes the Service on a port on every worker node's IP. You can reach it from outside the cluster by connecting to any node at that port. Use for exposing monitoring dashboards or REST APIs.
- **LoadBalancer** — requests a cloud provider's load balancer (e.g., AWS ELB, Azure Load Balancer) to route traffic from an external IP. Use for user-facing services.

A Service manifest:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: kafka-bootstrap
spec:
  type: ClusterIP
  selector:
    app: kafka-broker
  ports:
  - port: 9092
    targetPort: 9092
    name: broker
```

When you apply this, Kubernetes creates a DNS entry `kafka-bootstrap.default.svc.cluster.local` that resolves to a stable cluster IP. Requests to that IP are routed to all Pods with label `app: kafka-broker`. Under the hood, **kube-proxy** on each node manages `iptables` rules (or `ipvs` for larger clusters) to make the routing work.

## ConfigMaps and Secrets

**ConfigMaps** decouple configuration from container images. Instead of baking Spark configuration into a Docker image, you store it in a ConfigMap and mount it as a file or environment variable.

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: spark-conf
data:
  spark-defaults.conf: |
    spark.driver.memory 4g
    spark.executor.memory 8g
    spark.executor.cores 4
    spark.shuffle.service.enabled true
```

Mount it in a Pod:

```yaml
spec:
  containers:
  - name: spark-driver
    volumeMounts:
    - name: spark-conf
      mountPath: /opt/spark/conf
  volumes:
  - name: spark-conf
    configMap:
      name: spark-conf
```

**Secrets** are similar but intended for sensitive data: database passwords, S3 credentials, TLS certificates. Unlike ConfigMaps, Secrets are base64-encoded when stored in etcd (but not encrypted by default in vanilla Kubernetes — use encrypted etcd or an external secret manager in production).

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: s3-credentials
type: Opaque
data:
  access-key: QUtJQUlvRkRORllVRlQ1T0cxQQ==  # base64-encoded
  secret-key: dzVnRjFXUkZEUjBJZEVDVHJTMHBkRkZFQld0bW5STFQ=
```

## Namespaces: Logical Cluster Partitioning

A **Namespace** is a logical partition of a Kubernetes cluster. A single physical cluster can host multiple isolated environments: `dev`, `staging`, `prod`. Resources in one namespace are invisible to other namespaces by default (though network policies can enforce stricter isolation).

Resources are namespaced: when you run `kubectl get pods`, you see only Pods in the current namespace. Services in other namespaces are not accessible by default.

Use namespaces to:
- Separate environments: `dev-platform`, `prod-platform`
- Separate teams: `analytics-team`, `infra-team`
- Enforce resource quotas per team (see Part 6)

## Key Takeaways

- **Pods** are the atomic unit; they are ephemeral and managed by higher-level constructs
- **Deployments** ensure the right number of Pods exist and perform rolling updates
- **Services** provide stable DNS names and IPs for discovering Pods
- **ConfigMaps** store configuration; **Secrets** store sensitive data
- **Namespaces** logically partition the cluster

**Next:** [Part 2 — Storage and Configuration](/blog/kubernetes-series-2-storage-and-config)
