---
title: "Kafka Series, Part 5: Kafka Connect"
description: "Moving data in and out of Kafka without writing custom code — connectors, transforms, and running Connect in production."
pubDate: 2024-05-12
author: "ifkarsyah"
domain: "Streaming"
stack: ["Kafka"]
image:
  src: ./kafka-series.png
  alt: "Apache Kafka Connect"
---

## The Integration Problem

Every data platform eventually needs to move data between systems: sync a Postgres table into Kafka, stream Kafka events into S3, replicate a MongoDB collection to Elasticsearch. Writing custom producers and consumers for each integration is tedious and error-prone — you have to handle offset management, serialization, schema evolution, error handling, and restarts yourself.

**Kafka Connect** is Kafka's built-in integration framework. It provides a standardized way to move data in and out of Kafka using **connectors** — pre-built plugins for common systems. You configure connectors with JSON or properties files; Connect handles the rest.

## Architecture

Kafka Connect runs as a separate process (or cluster of processes). It has two roles:

- **Source connectors** read from external systems and write to Kafka topics
- **Sink connectors** read from Kafka topics and write to external systems

```
[PostgreSQL] → Source Connector → [Kafka Topic] → Sink Connector → [Elasticsearch]
```

Connect workers store their state (offsets, config, status) in Kafka topics themselves:

```properties
config.storage.topic=connect-configs
offset.storage.topic=connect-offsets
status.storage.topic=connect-status
```

## Standalone vs Distributed Mode

**Standalone** mode runs a single Connect worker — useful for development and simple, single-machine pipelines.

**Distributed** mode runs multiple workers that share load and provide fault tolerance. Connectors and their tasks are distributed across workers. If a worker fails, other workers take over its tasks. This is the production mode.

```bash
# Start a distributed Connect worker
connect-distributed.sh config/connect-distributed.properties
```

## Deploying a Connector

Connectors are deployed via REST API. Here is a source connector pulling from PostgreSQL using Debezium (CDC — change data capture):

```bash
curl -X POST http://localhost:8083/connectors \
  -H "Content-Type: application/json" \
  -d '{
    "name": "postgres-source",
    "config": {
      "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
      "database.hostname": "postgres",
      "database.port": "5432",
      "database.user": "replicator",
      "database.password": "secret",
      "database.dbname": "mydb",
      "table.include.list": "public.orders,public.users",
      "topic.prefix": "pg",
      "plugin.name": "pgoutput"
    }
  }'
```

This connector will:
1. Read the Postgres WAL (write-ahead log) for changes to `orders` and `users`
2. Publish each insert/update/delete as an event to topics `pg.public.orders` and `pg.public.users`

A sink connector writing to S3:

```bash
curl -X POST http://localhost:8083/connectors \
  -H "Content-Type: application/json" \
  -d '{
    "name": "s3-sink",
    "config": {
      "connector.class": "io.confluent.connect.s3.S3SinkConnector",
      "tasks.max": "4",
      "topics": "pg.public.orders",
      "s3.region": "us-east-1",
      "s3.bucket.name": "my-data-lake",
      "s3.part.size": "67108864",
      "storage.class": "io.confluent.connect.s3.storage.S3Storage",
      "format.class": "io.confluent.connect.s3.format.parquet.ParquetFormat",
      "flush.size": "10000",
      "rotate.interval.ms": "3600000"
    }
  }'
```

## Single Message Transforms (SMT)

Before records land in Kafka (or the sink), you can apply lightweight **transforms** in the connector configuration — no code required.

```json
{
  "transforms": "extractKey,addTimestamp",
  "transforms.extractKey.type": "org.apache.kafka.connect.transforms.ExtractField$Key",
  "transforms.extractKey.field": "id",
  "transforms.addTimestamp.type": "org.apache.kafka.connect.transforms.InsertField$Value",
  "transforms.addTimestamp.timestamp.field": "ingested_at"
}
```

Common transforms:
- `ExtractField` — use a field from the record as the key
- `ReplaceField` — rename, add, or drop fields
- `MaskField` — mask sensitive fields (PII)
- `Filter` — drop records matching a condition (Kafka 2.6+)
- `TimestampConverter` — convert timestamp formats

SMTs are designed for simple field-level operations. For anything more complex (joins, aggregations, branching logic), use Kafka Streams or Flink instead.

## Schema Registry Integration

Kafka Connect works well with the **Confluent Schema Registry**. When using Avro or Protobuf serialization, the connector registers the schema automatically and validates records against it.

```properties
key.converter=io.confluent.kafka.serializers.KafkaAvroSerializer
value.converter=io.confluent.kafka.serializers.KafkaAvroSerializer
key.converter.schema.registry.url=http://schema-registry:8081
value.converter.schema.registry.url=http://schema-registry:8081
```

Schema Registry enforces schema compatibility (backward, forward, full) as schemas evolve — preventing a schema change in one service from breaking downstream consumers.

## Managing Connectors

```bash
# List all connectors
curl http://localhost:8083/connectors

# Check connector status
curl http://localhost:8083/connectors/postgres-source/status

# Pause a connector
curl -X PUT http://localhost:8083/connectors/postgres-source/pause

# Restart a failed task
curl -X POST http://localhost:8083/connectors/postgres-source/tasks/0/restart

# Delete a connector
curl -X DELETE http://localhost:8083/connectors/postgres-source
```

## Popular Connectors

| Connector | Direction | Use Case |
|-----------|-----------|----------|
| Debezium PostgreSQL | Source | CDC from Postgres WAL |
| Debezium MySQL | Source | CDC from MySQL binlog |
| Debezium MongoDB | Source | CDC from MongoDB oplog |
| S3 Sink | Sink | Archive events to data lake |
| Elasticsearch Sink | Sink | Index events for search |
| JDBC Sink | Sink | Write to any JDBC database |
| HDFS Sink | Sink | Write to Hadoop/HDFS |
| HTTP Sink | Sink | Webhook delivery |

Most connectors are open source (Debezium, Apache Kafka project). Some are available only through Confluent Hub (commercial).

## Key Takeaways

- Kafka Connect is a **framework** for moving data between Kafka and external systems without writing custom code
- **Source connectors** bring data in; **sink connectors** push data out
- Run in **distributed mode** for production fault tolerance
- **Single Message Transforms** handle lightweight field-level manipulation inline
- Use **Schema Registry** with Avro/Protobuf for schema validation and evolution
- Debezium connectors enable **Change Data Capture** from relational databases — a powerful pattern for building event-driven systems from existing databases

**Next:** [Kafka Streams](/blog/kafka-series-6)
