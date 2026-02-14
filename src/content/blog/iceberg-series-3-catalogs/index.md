---
title: "Iceberg Series, Part 3: Catalogs"
description: "How Hive, Glue, REST, and Nessie catalogs coordinate multi-engine access to Iceberg tables — and why the catalog abstraction is Iceberg's biggest differentiator."
pubDate: 2024-10-27
author: "ifkarsyah"
tags: ["Iceberg", "Data Engineering", "Data Lake"]
image:
  src: ./iceberg-series.png
  alt: "Apache Iceberg Catalogs"
---

## Why the Catalog Is Critical

In Delta Lake, a table is a path: `s3://bucket/tables/events`. Every engine that reads it must know this path. There is no registry, no namespace, no governance layer.

In Iceberg, a table is a name in a **catalog**: `prod.analytics.events`. The catalog knows the path. Every engine queries the catalog to discover tables — and the catalog performs the atomic metadata swap when a table is updated.

This indirection enables:
- **Atomic table commits**: updating a table = updating one record in the catalog, not racing to write a file
- **Multi-engine coordination**: Spark, Trino, and Flink all query the same catalog; they see a consistent view
- **Table governance**: access control, auditing, and lineage live in the catalog, not scattered across engines
- **Namespace organization**: tables organized in hierarchical namespaces (`catalog.database.table`)

## The Catalog Interface

All Iceberg catalogs implement the same interface. From the engine's perspective, switching catalogs is a configuration change — no code changes required:

```python
# Spark config to use a catalog named "prod"
spark.conf.set("spark.sql.catalog.prod", "org.apache.iceberg.spark.SparkCatalog")
spark.conf.set("spark.sql.catalog.prod.catalog-impl", "<catalog-class>")
spark.conf.set("spark.sql.catalog.prod.uri", "<catalog-uri>")

# Access tables as: prod.database.table
spark.sql("SELECT * FROM prod.analytics.events")
```

## Hadoop Catalog (Development Only)

The simplest catalog — stores metadata files directly on the filesystem, no external service needed:

```python
spark.conf.set("spark.sql.catalog.local.type", "hadoop")
spark.conf.set("spark.sql.catalog.local.warehouse", "/tmp/warehouse")
```

The Hadoop catalog uses a directory structure for namespaces and relies on filesystem rename for atomicity. It is **not safe for concurrent writes** in production (S3 does not have atomic renames). Use it only for local development and testing.

## Hive Metastore Catalog

The most common production catalog for on-premise or self-managed setups. Iceberg stores table locations and metadata pointers as Hive table properties:

```python
spark.conf.set("spark.sql.catalog.hive_prod.type", "hive")
spark.conf.set("spark.sql.catalog.hive_prod.uri", "thrift://metastore-host:9083")
spark.conf.set("spark.sql.catalog.hive_prod.warehouse", "s3://bucket/warehouse")
```

The Hive Metastore (HMS) provides ACID guarantees for metadata updates through its own locking mechanism. Because HMS is widely deployed (Hive, Spark, Presto all use it), adding Iceberg on top of an existing HMS deployment is often the easiest migration path.

Trino configuration for the same catalog:

```properties
# trino/catalog/hive_prod.properties
connector.name=iceberg
iceberg.catalog.type=hive_metastore
hive.metastore.uri=thrift://metastore-host:9083
```

Both Spark and Trino read the same HMS → they see the same tables, same schema, same current snapshot.

## AWS Glue Catalog

AWS Glue Data Catalog is the managed Hive-compatible metastore on AWS. It is the default catalog for Athena, EMR, Glue ETL, and (increasingly) Iceberg on AWS:

```python
spark.conf.set("spark.sql.catalog.glue_prod.catalog-impl",
               "org.apache.iceberg.aws.glue.GlueCatalog")
spark.conf.set("spark.sql.catalog.glue_prod.warehouse", "s3://bucket/warehouse")
spark.conf.set("spark.sql.catalog.glue_prod.io-impl",
               "org.apache.iceberg.aws.s3.S3FileIO")
```

With Glue as the catalog:
- **AWS Athena** can query the table immediately — no extra configuration
- **AWS EMR** (Spark/Flink) uses the same Glue catalog
- **AWS Glue ETL** jobs read and write Iceberg natively
- Access control is managed through AWS IAM and Lake Formation

For AWS-native data platforms, Glue + Iceberg is the lowest-friction setup.

## Iceberg REST Catalog

The **REST Catalog** is the newest and most portable catalog type. It defines a standard HTTP API that any service can implement:

```python
spark.conf.set("spark.sql.catalog.rest_prod.type", "rest")
spark.conf.set("spark.sql.catalog.rest_prod.uri", "https://catalog.example.com")
spark.conf.set("spark.sql.catalog.rest_prod.credential", "client-id:client-secret")
```

REST catalog implementations include:
- **Tabular** (commercial, by the Iceberg creators)
- **AWS S3 Tables** (managed REST catalog on S3)
- **Polaris** (open-source, by Snowflake, donated to Apache)
- **Unity Catalog** (Databricks, with Iceberg REST support)
- **Gravitino** (Apache project, multi-format catalog)

The REST catalog API supports OAuth2 authentication, making it the cleanest foundation for centralized governance across engines and organizations.

```bash
# REST catalog API example
curl -H "Authorization: Bearer $TOKEN" \
  https://catalog.example.com/v1/namespaces/analytics/tables

# Returns a list of table names in the analytics namespace
```

## Project Nessie: Git-Like Branching

**Project Nessie** is a catalog with a unique feature: **git-like branching for data**. Tables live on branches, and you can create, merge, and delete branches of your entire catalog.

```python
spark.conf.set("spark.sql.catalog.nessie.catalog-impl",
               "org.projectnessie.iceberg.NessieCatalog")
spark.conf.set("spark.sql.catalog.nessie.uri", "http://nessie:19120/api/v1")
spark.conf.set("spark.sql.catalog.nessie.ref", "main")
```

Branch workflow:

```python
import requests

# Create a branch for experimental ETL
requests.post("http://nessie:19120/api/v1/trees/branch/experiment",
              json={"sourceRefName": "main"})

# Run ETL on the experiment branch — main is untouched
spark.conf.set("spark.sql.catalog.nessie.ref", "experiment")
spark.sql("INSERT INTO nessie.analytics.events SELECT ...")

# If the experiment looks good, merge to main
requests.post("http://nessie:19120/api/v1/trees/branch/main/merge",
              json={"fromRefName": "experiment"})
```

Use cases for Nessie:
- **Safe ETL testing**: run a new pipeline on a branch, validate results, then merge
- **Isolated environments**: dev/staging/prod branches of the same catalog
- **Reproducible ML**: tag a catalog state at model training time and reproduce it months later

## Choosing a Catalog

| Catalog | Best For | Atomicity | Multi-Engine |
|---------|----------|-----------|--------------|
| Hadoop | Local dev / testing | Filesystem (unsafe on S3) | Spark only |
| Hive Metastore | On-premise, existing HMS deployments | HMS locking | Spark, Trino, Hive, Flink |
| AWS Glue | AWS-native pipelines | DynamoDB lock | Spark, Athena, EMR, Flink |
| REST Catalog | Multi-cloud, cross-org sharing | Server-side | All engines |
| Nessie | Git-like branching workflows | Optimistic | Spark, Flink, Trino |

For new production deployments:
- **AWS** → Glue Catalog or AWS S3 Tables (REST)
- **GCP** → Biglake Metastore (REST)
- **On-premise or multi-cloud** → Hive Metastore or a REST catalog (Polaris, Tabular)
- **Experimental/branching** → Nessie

## Key Takeaways

- The catalog maps table names to metadata file locations — enabling atomic commits and multi-engine coordination
- **Hive Metastore** is the most widely deployed; works with Spark, Trino, Hive, and Flink out of the box
- **AWS Glue** is the zero-configuration choice for AWS-native stacks (Athena, EMR, Glue ETL all included)
- **REST Catalog** is the emerging standard — portable, OAuth2-secured, and implemented by Polaris, S3 Tables, Unity Catalog
- **Nessie** adds git-like branching — create isolated catalog branches for ETL testing and safe deployments

Next: Hidden Partitioning & Evolution — how Iceberg's partition transforms and partition evolution work, and why they eliminate a whole class of data engineering pain.
