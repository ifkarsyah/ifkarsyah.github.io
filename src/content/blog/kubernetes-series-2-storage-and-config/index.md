---
title: "Kubernetes Series, Part 2: Storage and Configuration"
description: "PersistentVolumes, PersistentVolumeClaims, StorageClasses, Secrets, and ConfigMaps — how stateful data workloads survive pod restarts."
pubDate: 2026-02-22
author: "ifkarsyah"
tags: ["Kubernetes", "Data Engineering", "DevOps"]
---

## Why Storage Is Hard in Kubernetes

Containers are ephemeral: when a Pod is deleted or crashes, its filesystem is gone. For stateless workloads (a Spark driver, a Kafka consumer that reads from an offset), this is fine — the state lives elsewhere (in Kafka, in a database, in object storage). But for stateful workloads (Flink checkpoints, Kafka brokers storing log data, Spark shuffle files), you need persistent storage that survives Pod restarts.

Kubernetes abstracts storage through a layered system: **StorageClass** → **PersistentVolume** → **PersistentVolumeClaim**. This allows workloads to request storage without knowing whether it is backed by AWS EBS, Azure Disk, NFS, or local SSD.

## The Storage Abstraction Stack

**StorageClass** defines the type of storage: SSD vs HDD, fast vs slow, replication level. A cluster typically has several:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: fast-ssd
provisioner: ebs.csi.aws.com
parameters:
  type: gp3
  iops: "3000"
  throughput: "125"
allowVolumeExpansion: true
```

**PersistentVolume (PV)** is a piece of actual storage provisioned in the cluster. In dynamic provisioning (the norm), when a workload requests storage via a **PersistentVolumeClaim**, a controller automatically creates a PV by calling the cloud provider's API.

**PersistentVolumeClaim (PVC)** is a request for storage. A Pod mounts a PVC like it mounts a ConfigMap, but the PVC is bound to a PV with actual storage.

This separation lets workloads say "I need 100 GB of fast SSD storage" without knowing whether that storage is on AWS, Azure, or an on-premise cluster.

## PVC Walkthrough

A minimal PVC:

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: flink-checkpoints
spec:
  accessModes:
    - ReadWriteOnce
  storageClassName: fast-ssd
  resources:
    requests:
      storage: 50Gi
```

**accessModes** describes how the storage can be accessed:
- `ReadWriteOnce (RWO)` — can be read and written by a single node at a time. Most cloud block storage (AWS EBS, Azure Disk) supports only RWO. This means a PVC can be mounted by only one Pod at a time, and only if that Pod is on the node where the PV is attached.
- `ReadWriteMany (RWX)` — can be read and written by multiple nodes simultaneously. NFS supports RWX. This is essential for shared storage (e.g., Spark shuffle using NFS), but NFS is slower than block storage.

For data workloads, most deployments use RWO block storage because it is faster, and the workload is designed to run on a single node (e.g., Kafka brokers, Flink task managers use local storage and replicate across multiple instances).

Mount a PVC in a Pod:

```yaml
spec:
  containers:
  - name: flink-taskmanager
    volumeMounts:
    - name: checkpoint-storage
      mountPath: /checkpoints
  volumes:
  - name: checkpoint-storage
    persistentVolumeClaim:
      claimName: flink-checkpoints
```

## Storage for Data Workloads

**Flink Checkpoints:** Flink periodically saves its state to object storage or a filesystem. On Kubernetes, use either:
- A PVC mounted at `/checkpoints`, backed by cloud block storage or NFS
- S3 or S3-compatible storage (MinIO), specified in `flink-conf.yaml`

PVCs are simpler to set up inside a cluster; object storage is more scalable and survives cluster deletion.

**Spark Shuffle Storage:** When Spark executors shuffle data, they write shuffle blocks to local disk by default. If an executor is evicted or fails, those blocks are lost and Spark must re-compute them. Options:
- Local SSD (default): fastest, but not fault-tolerant
- Remote Shuffle Service (Uniffle, Spark's own RSS): shuffle data written to a separate service, survives executor loss
- S3: slow, but very durable; use only for backfill jobs where performance is not critical

Most production Spark deployments on K8s use local SSD and rely on Spark's native fault tolerance (re-compute lost shuffle blocks), or use a Remote Shuffle Service for higher reliability.

**Kafka Log Storage:** Kafka brokers store log data on disk. On Kubernetes, each Kafka broker Pod must have its own PVC backed by fast block storage (RWO). Kafka replicates data across multiple brokers, so if one broker's storage fails, the data is replicated on other brokers.

## ConfigMaps in Depth

ConfigMaps store configuration files, environment variables, or arbitrary data. For data workloads, you often mount a ConfigMap containing a configuration file:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: flink-config
data:
  flink-conf.yaml: |
    jobmanager.rpc.address: flink-jobmanager
    jobmanager.rpc.port: 6123
    state.backend: filesystem
    state.checkpoints.dir: s3://my-bucket/checkpoints
    state.savepoints.dir: s3://my-bucket/savepoints
```

Mount it in a Flink Deployment:

```yaml
spec:
  containers:
  - name: jobmanager
    volumeMounts:
    - name: flink-conf
      mountPath: /opt/flink/conf
  volumes:
  - name: flink-conf
    configMap:
      name: flink-config
```

## Secrets Management

Kubernetes Secrets are stored in etcd as base64-encoded data. Base64 is not encryption — anyone with etcd access can decode them. For production:

- **Enable etcd encryption at rest** — Kubernetes can encrypt data before storing it in etcd
- **Use an external secret manager** — HashiCorp Vault, AWS Secrets Manager, Azure Key Vault — integrated via the **External Secrets Operator**
- **Minimize secret scope** — use short-lived credentials (AWS STS tokens) instead of long-lived IAM keys

A basic secret for S3 credentials:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: s3-credentials
type: Opaque
stringData:  # plaintext; K8s base64-encodes it
  access-key: AKIAIOFDNEFY5EXAMPLE
  secret-key: wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

Access in a Pod via environment variables:

```yaml
spec:
  containers:
  - name: spark-driver
    env:
    - name: AWS_ACCESS_KEY_ID
      valueFrom:
        secretKeyRef:
          name: s3-credentials
          key: access-key
    - name: AWS_SECRET_ACCESS_KEY
      valueFrom:
        secretKeyRef:
          name: s3-credentials
          key: secret-key
```

## Key Takeaways

- **StorageClasses** define types of storage; **PVCs** request storage; **PVs** are the actual storage
- **RWO** block storage is fast but single-node; **RWX** NFS is multi-node but slower
- **Flink checkpoints** use object storage or PVCs; **Kafka brokers** need fast PVCs; **Spark shuffle** uses local disks or remote shuffle services
- **ConfigMaps** store configuration files; **Secrets** store sensitive data (encrypted at rest in production)

**Next:** [Part 3 — Workload Patterns for Data Engineering](/blog/kubernetes-series-3-workload-patterns)
