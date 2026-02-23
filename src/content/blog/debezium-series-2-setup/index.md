---
title: "Debezium Series, Part 2: Setting Up Debezium"
description: "Hands-on Docker Compose setup with PostgreSQL, Kafka, Kafka Connect, and the Debezium connector. See your first change event in under 10 minutes."
pubDate: 2026-02-25
author: "ifkarsyah"
domain: "Streaming"
stack: ["Debezium", "Kafka", "PostgreSQL"]
---

Theory is useful. A running pipeline is better. This part walks through a complete local setup — PostgreSQL, Kafka, and Debezium — using Docker Compose. By the end, you will insert a row into PostgreSQL and watch it appear as a Kafka event.

## The Stack

```
┌─────────────────────────────────────────────────────┐
│  Docker Compose                                     │
│                                                     │
│  postgres:16    ──WAL──►  kafka-connect             │
│                           (debezium/connect:2.7)    │
│  zookeeper                       │                  │
│  kafka:3.7      ◄────────────────┘                  │
└─────────────────────────────────────────────────────┘
```

## docker-compose.yml

```yaml
version: "3.8"

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: dbuser
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: shop
    command:
      - "postgres"
      - "-c"
      - "wal_level=logical"
      - "-c"
      - "max_replication_slots=5"
      - "-c"
      - "max_wal_senders=5"
    ports:
      - "5432:5432"

  zookeeper:
    image: confluentinc/cp-zookeeper:7.6.0
    environment:
      ZOOKEEPER_CLIENT_PORT: 2181

  kafka:
    image: confluentinc/cp-kafka:7.6.0
    depends_on:
      - zookeeper
    environment:
      KAFKA_BROKER_ID: 1
      KAFKA_ZOOKEEPER_CONNECT: zookeeper:2181
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://kafka:9092
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
    ports:
      - "9092:9092"

  connect:
    image: debezium/connect:2.7
    depends_on:
      - kafka
      - postgres
    environment:
      BOOTSTRAP_SERVERS: kafka:9092
      GROUP_ID: debezium-group
      CONFIG_STORAGE_TOPIC: debezium_configs
      OFFSET_STORAGE_TOPIC: debezium_offsets
      STATUS_STORAGE_TOPIC: debezium_status
    ports:
      - "8083:8083"
```

Start everything:

```bash
docker compose up -d
```

Wait about 30 seconds for Kafka to initialize, then verify Connect is healthy:

```bash
curl -s http://localhost:8083/connectors | jq
# []  — empty list, no connectors yet
```

## Create the Source Table

Connect to PostgreSQL and create a table to monitor:

```bash
docker compose exec postgres psql -U dbuser -d shop
```

```sql
CREATE TABLE orders (
    id         SERIAL PRIMARY KEY,
    customer   TEXT        NOT NULL,
    product    TEXT        NOT NULL,
    amount     NUMERIC(10,2),
    status     TEXT        DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Required: grant replication permissions
ALTER TABLE orders REPLICA IDENTITY FULL;
```

`REPLICA IDENTITY FULL` tells PostgreSQL to include the full before-image of each row in the WAL. Without it, UPDATE and DELETE events will not contain the old values.

## Register the Debezium Connector

Send a POST request to Kafka Connect's REST API:

```bash
curl -X POST http://localhost:8083/connectors \
  -H "Content-Type: application/json" \
  -d '{
    "name": "orders-connector",
    "config": {
      "connector.class": "io.debezium.connector.postgresql.PostgresConnector",
      "database.hostname": "postgres",
      "database.port": "5432",
      "database.user": "dbuser",
      "database.password": "secret",
      "database.dbname": "shop",
      "database.server.name": "shop",
      "topic.prefix": "shop",
      "table.include.list": "public.orders",
      "plugin.name": "pgoutput",
      "slot.name": "debezium_orders",
      "publication.name": "debezium_publication"
    }
  }'
```

Check connector status:

```bash
curl -s http://localhost:8083/connectors/orders-connector/status | jq
```

You should see `"state": "RUNNING"` for both the connector and its task.

## Watch the Topic

Open a consumer on the orders topic:

```bash
docker compose exec kafka \
  kafka-console-consumer \
  --bootstrap-server kafka:9092 \
  --topic shop.public.orders \
  --from-beginning
```

Nothing yet — the topic exists but no changes have been captured (only the snapshot will arrive, which we cover in Part 7).

## Trigger Your First Change Event

In a second terminal, insert a row:

```bash
docker compose exec postgres psql -U dbuser -d shop -c \
  "INSERT INTO orders (customer, product, amount) VALUES ('alice', 'laptop', 1299.00);"
```

In the consumer terminal, you'll see a JSON event appear almost immediately:

```json
{
  "schema": { ... },
  "payload": {
    "before": null,
    "after": {
      "id": 1,
      "customer": "alice",
      "product": "laptop",
      "amount": 1299.00,
      "status": "pending",
      "created_at": "2026-02-25T10:00:00.000000Z"
    },
    "source": {
      "version": "2.7.0.Final",
      "connector": "postgresql",
      "name": "shop",
      "ts_ms": 1740477600000,
      "db": "shop",
      "schema": "public",
      "table": "orders",
      "lsn": 23456789
    },
    "op": "c",
    "ts_ms": 1740477600123
  }
}
```

`"op": "c"` means create (insert). `"before": null` because there was no previous state.

Now update the row:

```bash
docker compose exec postgres psql -U dbuser -d shop -c \
  "UPDATE orders SET status = 'shipped' WHERE id = 1;"
```

A second event appears:

```json
{
  "payload": {
    "before": {
      "id": 1, "status": "pending", ...
    },
    "after": {
      "id": 1, "status": "shipped", ...
    },
    "op": "u"
  }
}
```

`"op": "u"` — update. Both before and after states are present because of `REPLICA IDENTITY FULL`.

Delete it:

```bash
docker compose exec postgres psql -U dbuser -d shop -c \
  "DELETE FROM orders WHERE id = 1;"
```

Two events arrive: a delete event with `"op": "d"` and then a **tombstone** — a message with a null value and the same key. The tombstone signals Kafka to garbage-collect the key in log-compacted topics.

## Useful Connector Management Commands

```bash
# List all connectors
curl -s http://localhost:8083/connectors | jq

# Pause a connector
curl -X PUT http://localhost:8083/connectors/orders-connector/pause

# Resume a connector
curl -X PUT http://localhost:8083/connectors/orders-connector/resume

# Delete a connector (does NOT drop the replication slot)
curl -X DELETE http://localhost:8083/connectors/orders-connector

# Check replication slot in PostgreSQL
docker compose exec postgres psql -U dbuser -d shop -c \
  "SELECT slot_name, confirmed_flush_lsn FROM pg_replication_slots;"
```

**Important:** Deleting a connector via the REST API does not drop the PostgreSQL replication slot. Drop it manually to avoid WAL accumulation:

```sql
SELECT pg_drop_replication_slot('debezium_orders');
```

## Key Takeaways

- Debezium runs as a Kafka Connect plugin — one REST call registers a connector
- `wal_level = logical` and `REPLICA IDENTITY FULL` are required on the PostgreSQL side
- Insert → `op: c`, Update → `op: u` (with before/after), Delete → `op: d` + tombstone
- The replication slot persists independently of the connector — manage it explicitly
- Connector status is available via `GET /connectors/{name}/status`

**Next:** [Change Event Anatomy](/blog/debezium-series-3-change-event-anatomy)
