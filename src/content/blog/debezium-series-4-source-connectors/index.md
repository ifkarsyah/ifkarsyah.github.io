---
title: "Debezium Series, Part 4: Source Connectors — PostgreSQL & MySQL"
description: "Deep dive into PostgreSQL (pgoutput) and MySQL (binlog) source connectors. Configuration reference, behavioral differences, and connector-specific gotchas."
pubDate: 2026-02-27
author: "ifkarsyah"
domain: "Streaming"
stack: ["Debezium", "Kafka", "PostgreSQL"]
---

Debezium supports many databases but PostgreSQL and MySQL cover the vast majority of production use cases. Each uses a fundamentally different replication mechanism, which leads to different behaviors, configuration patterns, and operational concerns.

## PostgreSQL Connector

### How It Works

The PostgreSQL connector uses **logical replication** — a PostgreSQL feature that decodes WAL records into a stream of row changes.

```
WAL (binary) → pgoutput plugin → replication slot → Debezium → Kafka
```

PostgreSQL creates a **publication** (a declaration of which tables to replicate) and a **replication slot** (a cursor tracking how much WAL the consumer has read). Debezium manages both automatically.

### Required PostgreSQL Configuration

```ini
# postgresql.conf
wal_level = logical
max_replication_slots = 10
max_wal_senders = 10
```

The user Debezium connects as needs replication privileges:

```sql
CREATE USER debezium_user WITH REPLICATION LOGIN PASSWORD 'secret';
GRANT SELECT ON ALL TABLES IN SCHEMA public TO debezium_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO debezium_user;
```

### REPLICA IDENTITY

Controls what is stored in the WAL for UPDATE and DELETE operations:

| Setting | Before image | Use case |
|---------|-------------|----------|
| `DEFAULT` | Primary key only | Minimal WAL, but `before` is incomplete |
| `FULL` | All columns | Full before/after — required for complete CDC |
| `NOTHING` | None | No before image at all — avoid for CDC |
| `USING INDEX idx` | Indexed columns | Partial — only useful for specific cases |

```sql
ALTER TABLE orders REPLICA IDENTITY FULL;
```

Set this on every table before registering the connector, or updates/deletes will arrive with null `before`.

### Connector Configuration

```json
{
  "name": "pg-orders-connector",
  "config": {
    "connector.class": "io.debezium.connector.postgresql.PostgresConnector",

    "database.hostname": "postgres",
    "database.port": "5432",
    "database.user": "debezium_user",
    "database.password": "secret",
    "database.dbname": "shop",

    "topic.prefix": "shop",
    "plugin.name": "pgoutput",
    "slot.name": "debezium_shop",
    "publication.name": "debezium_publication",

    "table.include.list": "public.orders,public.products",

    "snapshot.mode": "initial",
    "decimal.handling.mode": "string",
    "time.precision.mode": "connect",

    "heartbeat.interval.ms": "10000",
    "slot.max.retries": "5"
  }
}
```

### Key PostgreSQL-Specific Settings

**`plugin.name`**: Always use `pgoutput` (built-in since PostgreSQL 10). The legacy plugins `wal2json` and `decoderbufs` require separate installation and are rarely needed today.

**`publication.name`**: Debezium creates a PostgreSQL publication with this name. If you create the publication manually (e.g., for fine-grained control), set `publication.autocreate.mode = disabled`.

**`heartbeat.interval.ms`**: If only low-traffic tables are monitored, the WAL position may not advance, causing the replication slot to fall behind. Heartbeat events force regular WAL position updates even when no changes occur on tracked tables.

**`slot.drop.on.stop`**: When `true`, the replication slot is dropped when the connector stops. Useful for development; dangerous in production — dropping the slot loses the position.

### PostgreSQL-Specific Behaviors

**Truncate events**: PostgreSQL 11+ propagates TRUNCATE through logical replication. Debezium captures this as `op: "t"`. MySQL does not propagate TRUNCATE at all.

**Transaction boundaries**: Debezium can optionally group events by transaction using `provide.transaction.metadata = true`. This adds a `transaction` field to each event and publishes a separate transaction metadata topic.

**Enum types**: PostgreSQL enums are captured as strings. If the enum value changes (e.g., a new value is added), the schema must be updated in the schema registry.

---

## MySQL Connector

### How It Works

The MySQL connector reads the **binary log** (binlog) — MySQL's replication log. Unlike PostgreSQL, MySQL does not use a plugin layer; Debezium connects as a replica and reads the binlog directly.

```
MySQL binlog → Debezium (acting as a replica) → Kafka
```

### Required MySQL Configuration

```ini
# my.cnf or my.ini
server-id           = 1
log_bin             = /var/log/mysql/mysql-bin.log
binlog_format       = ROW
binlog_row_image    = FULL
expire_logs_days    = 10

# Recommended for safer failover
gtid_mode               = ON
enforce_gtid_consistency = ON
```

The connector user needs specific grants:

```sql
CREATE USER 'debezium'@'%' IDENTIFIED BY 'secret';
GRANT SELECT, RELOAD, SHOW DATABASES, REPLICATION SLAVE, REPLICATION CLIENT ON *.* TO 'debezium'@'%';
FLUSH PRIVILEGES;
```

### Connector Configuration

```json
{
  "name": "mysql-orders-connector",
  "config": {
    "connector.class": "io.debezium.connector.mysql.MySqlConnector",

    "database.hostname": "mysql",
    "database.port": "3306",
    "database.user": "debezium",
    "database.password": "secret",
    "database.server.id": "184054",

    "topic.prefix": "shop",
    "database.include.list": "shop",
    "table.include.list": "shop.orders,shop.products",

    "snapshot.mode": "initial",
    "decimal.handling.mode": "string",
    "include.schema.changes": "true"
  }
}
```

**`database.server.id`**: MySQL's replication protocol requires each replica to have a unique server ID. Pick any integer not used by another replica. Conflicts cause mysterious replication failures.

**`include.schema.changes`**: When `true`, DDL changes (ALTER TABLE, CREATE TABLE) are published to a separate schema history topic. MySQL requires this for proper schema tracking; PostgreSQL does not.

### MySQL Schema History Topic

MySQL's approach to schema tracking is fundamentally different from PostgreSQL's. Because the binlog records SQL statements, Debezium must know the exact schema at the time each change was made.

Debezium maintains a **schema history topic** in Kafka that records every DDL statement seen. On startup, it replays this history to reconstruct the schema at the current binlog position.

```json
"schema.history.internal.kafka.topic": "schema-changes.shop",
"schema.history.internal.kafka.bootstrap.servers": "kafka:9092"
```

This topic must be retained indefinitely (set `cleanup.policy=delete` with a very long `retention.ms`). Losing it means the connector cannot restart.

---

## PostgreSQL vs MySQL — Key Differences

| Aspect | PostgreSQL | MySQL |
|--------|-----------|-------|
| Log mechanism | WAL + logical replication | Binary log |
| Position tracking | LSN | Binlog file + offset, or GTID |
| Schema tracking | Inline (schema stored in WAL) | Separate schema history topic required |
| Truncate support | Yes (`op: "t"`) | No |
| Before image | Requires `REPLICA IDENTITY FULL` | Requires `binlog_row_image = FULL` |
| DDL propagation | Via schema changes (limited) | Full DDL via schema history |
| Multi-database | One connector per database | One connector can cover multiple databases |
| Replication slot | Yes — persists, must manage | No slot concept — position in binlog |

## Table Filtering

Both connectors support include/exclude lists for databases and tables:

```json
"table.include.list": "public.orders,public.products"
"table.exclude.list": "public.internal_audit,public.sessions"
```

Prefer `table.include.list` (allowlist) over `table.exclude.list` (denylist). New tables added to the database will not be captured unless explicitly included, which is safer than accidentally capturing sensitive tables via a denylist.

## Key Takeaways

- PostgreSQL uses WAL + `pgoutput`; requires `REPLICA IDENTITY FULL` for complete before-images
- MySQL uses the binlog; requires `binlog_format = ROW` and `binlog_row_image = FULL`
- MySQL requires a separate **schema history topic**; PostgreSQL does not
- PostgreSQL propagates TRUNCATE; MySQL does not
- Use `table.include.list` allowlists over exclude lists for predictable behavior
- PostgreSQL replication slots persist — manage them explicitly; MySQL binlog position does not require manual cleanup

**Next:** [Sink Connectors — Delta Lake & Iceberg](/blog/debezium-series-5-sink-connectors)
