---
title: "Kadita — Config-Driven Data Ingestion Platform"
description: "A Kubernetes-inspired YAML-configured data platform that ingests from Postgres, MySQL, MongoDB, Jira, Zendesk, and S3 into an Apache Iceberg data lake."
date: 2025-09-22
tags: ["Apache Iceberg", "S3", "Data Lake", "YAML", "Python"]
link: "https://github.com/ifkarsyah/kadita"
image: ""
featured: false
---

## Overview

**Kadita** is a configuration-driven data ingestion platform inspired by Kubernetes resource manifests. Instead of writing ingestion code for each data source, you declare your sources and tables in YAML — and Kadita handles the rest, landing data into an Apache Iceberg table on S3.

## Configuration Model

Kadita uses a `DataSource` / `TableConfig` separation, similar to how Kubernetes separates `Deployment` from `Service`:

```yaml
# datasource.yaml
apiVersion: kadita/v1
kind: DataSource
metadata:
  name: my-postgres
spec:
  type: postgres
  host: db.example.com
  database: production
```

```yaml
# table.yaml
apiVersion: kadita/v1
kind: TableConfig
metadata:
  name: users-table
spec:
  source: my-postgres
  table: users
  destination:
    format: iceberg
    path: s3://datalake/users/
```

## Supported Sources

| Source | Type |
|--------|------|
| PostgreSQL | Relational DB |
| MySQL | Relational DB |
| MongoDB | Document DB |
| Jira | SaaS API |
| Zendesk | SaaS API |
| S3 Files | Object Storage |

## Tech Stack

- **Apache Iceberg** — open table format for the data lake
- **S3** — storage layer
- **Python** — ingestion engine
- **YAML** — declarative configuration
