---
title: "Kubernetes Series, Part 0: Overview"
description: "What is Kubernetes, what problem it solves over bare metal and Docker, and a roadmap for running data workloads on K8s."
pubDate: 2026-02-22
author: "ifkarsyah"
domain: "Infrastructure"
stack: ["Kubernetes"]
---

## What Is Kubernetes?

Kubernetes (K8s) is an open-source container orchestration system. You describe the desired state of your system — "run 3 copies of this container, with 4 GB of RAM each, and restart them if they crash" — and Kubernetes continuously works to make reality match that description. It was originally designed at Google (based on their internal Borg system) and donated to the CNCF in 2014.

The core insight of Kubernetes is the **reconciliation loop**: a control plane that watches the actual state of your cluster and drives it toward the desired state you declared. You do not issue imperative commands ("start this process"). You declare intent ("this service should always have 3 healthy replicas"), and Kubernetes figures out how to get there and keep it there.

## The Problem Kubernetes Solves

When you run data pipelines in production, you quickly hit a set of recurring problems:

- **Reliability**: Spark executors crash. Flink task managers run out of memory. Kafka brokers restart. How do you ensure the workload comes back up automatically?
- **Resource isolation**: A runaway Flink job should not starve a Kafka consumer on the same host. How do you enforce CPU and memory limits?
- **Scaling**: A Spark job needs 20 executors today and 200 next month during a backfill. How do you provision resources on demand?
- **Scheduling**: A nightly batch job needs to run at 02:00 UTC, only if a dataset is ready, and retry on failure. How do you manage that without a custom scheduler?
- **Environment consistency**: The job works on the developer's laptop but fails in production due to a different Java version. How do you guarantee reproducibility?

Kubernetes addresses all of these through a combination of containerization, declarative configuration, and a sophisticated scheduler.

## K8s vs Other Deployment Approaches

| | Bare Metal | VMs | Docker Compose | Kubernetes |
|---|---|---|---|---|
| Isolation | None | Strong (hypervisor) | Process (cgroups) | Process (cgroups) |
| Restart on failure | Manual | Cloud provider dependent | `restart: always` | Automatic (liveness probes) |
| Resource limits | None | VM size | Container limits | Pod requests/limits |
| Scheduling | Manual | Manual | Manual | Automatic (scheduler) |
| Scaling | Manual | Manual | Manual (`--scale`) | Automatic (HPA, KEDA) |
| Multi-node | Manual setup | Cloud-dependent | No (single host) | Native |
| State management | Filesystem | VM disk | Volume mounts | PersistentVolumes |
| Data workload support | Raw JVM | Custom AMIs | Dev only | Production-grade (Operators) |
| Operational overhead | High | Medium | Low (small scale) | Medium (large scale) |

**Docker Compose** is the right tool for local development — spinning up Kafka + Spark + a database on your laptop in one command. It does not handle multi-node deployments, automatic failure recovery, or resource scheduling.

**VMs** give you isolation and can be automated with Terraform and configuration management tools, but you end up managing operating systems, runtimes, and software versions manually across many machines.

**Kubernetes** is the right tool when you need automated scheduling, failure recovery, resource management, and scalable deployments across a cluster — which describes every serious data platform.

## Kubernetes Architecture

A Kubernetes cluster has two main parts: the **control plane** and the **data plane** (worker nodes).

```
┌─────────────────────────────────────────────────────┐
│                    Control Plane                    │
│                                                     │
│   ┌──────────────┐  ┌──────────┐  ┌─────────────┐  │
│   │  API Server  │  │  etcd    │  │  Scheduler  │  │
│   │  (gateway)   │  │ (state)  │  │  (placement)│  │
│   └──────────────┘  └──────────┘  └─────────────┘  │
│                                                     │
│   ┌──────────────────────────────────────────────┐  │
│   │         Controller Manager                   │  │
│   │  (reconciles desired vs actual state)        │  │
│   └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
          │                    │                │
          ▼                    ▼                ▼
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│  Worker Node │    │  Worker Node │    │  Worker Node │
│              │    │              │    │              │
│  ┌────────┐  │    │  ┌────────┐  │    │  ┌────────┐  │
│  │kubelet │  │    │  │kubelet │  │    │  │kubelet │  │
│  └────────┘  │    │  └────────┘  │    │  └────────┘  │
│  ┌────────┐  │    │  ┌────────┐  │    │  ┌────────┐  │
│  │  Pod   │  │    │  │  Pod   │  │    │  │  Pod   │  │
│  │  Pod   │  │    │  │  Pod   │  │    │  │  Pod   │  │
│  └────────┘  │    │  └────────┘  │    │  └────────┘  │
└──────────────┘    └──────────────┘    └──────────────┘
```

**Control Plane components:**

- **API Server** — the single entry point for all K8s operations. Every `kubectl` command, every Operator, every CI/CD system goes through the API server. It validates requests and persists state to etcd.
- **etcd** — a distributed key-value store that holds the entire cluster state. All desired and actual state lives here. If etcd is lost without a backup, the cluster state is gone.
- **Scheduler** — watches for newly created Pods with no assigned node, then selects the best node based on resource requirements, affinity rules, and taints/tolerations.
- **Controller Manager** — runs a set of reconciliation loops. The Deployment controller ensures the right number of Pods exist. The Node controller monitors node health. Many controllers, one process.

**Worker Node components:**

- **kubelet** — the agent on each worker node. It watches the API server for Pods assigned to its node and starts/stops containers accordingly.
- **kube-proxy** — manages network routing rules so that Services can route traffic to the correct Pods.
- **Container runtime** — the software that actually runs containers (containerd is standard; Docker is no longer used directly).

**The Pod** is the smallest deployable unit in Kubernetes — one or more containers that share a network namespace and storage, always scheduled together.

## Why Data Engineers Should Care About Kubernetes

The data engineering tools you already know have first-class Kubernetes support:

- **Spark** — native K8s scheduler mode since Spark 2.3; the Spark Kubernetes Operator makes submitting jobs declarative
- **Flink** — the Flink Kubernetes Operator handles session clusters, application mode, and checkpointing automatically
- **Kafka** — Strimzi turns Kafka cluster management into a set of Kubernetes Custom Resources
- **Airflow** — the KubernetesExecutor runs each DAG task as an isolated Pod, scaling to zero between runs

Running these tools on Kubernetes gives you a unified control plane, consistent resource management, and the same operational patterns across your entire data platform.

## The Series Roadmap

This series covers Kubernetes from fundamentals to running production data workloads:

- **Part 0 (this post)** — Overview: what K8s is, the problem it solves, and the architecture
- **Part 1** — Core Concepts: Pods, Deployments, Services, ConfigMaps, and Namespaces
- **Part 2** — Storage and Configuration: PersistentVolumes, PVCs, StorageClasses, and Secrets
- **Part 3** — Workload Patterns for Data Engineering: StatefulSets, Jobs, CronJobs, and DaemonSets
- **Part 4** — Running Spark on Kubernetes: native scheduler mode, the Spark Operator, executor sizing
- **Part 5** — Running Flink and Kafka on Kubernetes: Flink Operator, Strimzi, and streaming workload patterns
- **Part 6** — Production Operations: autoscaling, monitoring, resource quotas, and cost management

## Prerequisites

This series assumes:

- Comfort with the command line and basic shell scripting
- Familiarity with Docker — building images, running containers, understanding layers
- Basic understanding of at least one data processing framework (Spark, Flink, or Kafka)
- No prior Kubernetes experience required — this series starts from zero

To follow along hands-on, you will need either:
- **minikube** or **kind** for a local single-node cluster (recommended for Parts 1-3)
- A managed cluster (GKE, EKS, AKS) for the data workload parts (Parts 4-6), where resource requirements are higher

**Next:** [Part 1 — Core Concepts](/blog/kubernetes-series-1-core-concepts)
