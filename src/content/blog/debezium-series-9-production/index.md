---
title: "Debezium Series, Part 9: Production Concerns"
description: "Operating Debezium in production: offset management, failure recovery, monitoring connector lag, replication slot health, rebalancing, and the operational patterns that keep CDC pipelines healthy."
pubDate: 2026-03-04
author: "ifkarsyah"
domain: "Streaming"
stack: ["Debezium", "Kafka", "PostgreSQL"]
---

Running Debezium in development is straightforward. Running it in production — where pipelines must survive failures, schema changes, and traffic spikes — requires understanding its operational model. This final part covers the failure modes, monitoring strategy, and operational runbooks you need.

## How Debezium Tracks Position

Debezium stores its position (how far it has read from the WAL or binlog) as a Kafka Connect **offset**. Offsets are stored in Kafka itself — in the `connect-offsets` topic by default.

```json
// Offset key (which connector + partition)
{ "server": "shop" }

// Offset value (PostgreSQL)
{ "lsn": 23456789, "txId": 491 }

// Offset value (MySQL)
{ "file": "mysql-bin.000003", "pos": 1234567, "gtid": "..." }
```

On restart, Debezium reads the stored offset and resumes from that position. The replication slot (PostgreSQL) or binlog position (MySQL) is the source of truth — the Kafka offset is Debezium's local bookmark.

## Failure Modes

### Connector Crash (Debezium Restarts)

Debezium publishes to Kafka, then commits the offset. If it crashes between publish and commit, the same events are re-published on restart — **duplicates**. This is the at-least-once guarantee in action.

Mitigation: design sinks to be idempotent (upsert semantics, deduplication by primary key).

### Kafka Connect Worker Crash

Kafka Connect is a distributed system. If a worker crashes, Kafka Connect rebalances connectors to surviving workers. During rebalancing (typically 30–60 seconds), the connector is paused. No events are lost — the replication slot retains WAL during the pause.

### WAL Accumulation (PostgreSQL)

If Debezium is offline, the replication slot prevents WAL from being deleted. Disk fills up if Debezium is offline too long.

```sql
-- Check WAL retained by each slot
SELECT slot_name,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS retained_wal
FROM pg_replication_slots;
```

Set a safety limit:

```ini
# postgresql.conf (PostgreSQL 13+)
max_slot_wal_keep_size = 20GB
```

When the limit is exceeded, PostgreSQL invalidates the slot. The connector must restart with `snapshot.mode = initial` or `when_needed` to re-bootstrap.

### MySQL Binlog Rotation

MySQL rotates binlog files based on `expire_logs_days` or `binlog_expire_logs_seconds`. If Debezium's saved position refers to a rotated (deleted) file, the connector fails with a "binlog not found" error.

Mitigation:
- Set `expire_logs_days` longer than the maximum expected Debezium downtime
- Monitor binlog lag (see below)
- Use GTIDs — they make position recovery more reliable than file + offset

### Replication Slot Invalidated

PostgreSQL can invalidate a replication slot if `max_slot_wal_keep_size` is exceeded or if the slot is explicitly dropped. When invalidated, the connector cannot resume from the saved position.

Recovery:
1. Delete the connector
2. Drop the replication slot (`SELECT pg_drop_replication_slot('debezium_orders')`)
3. Re-register the connector with `snapshot.mode = initial`

## Monitoring

### Key Metrics (JMX / Prometheus)

Debezium exposes metrics via JMX. With the Prometheus JMX exporter, these become scrapeable metrics:

**Connector lag:**
```
debezium_metrics_MilliSecondsBehindSource{connector="shop"}
```
Target: < 1000ms for near-real-time; < 60000ms for batch CDC.

**Events processed:**
```
debezium_metrics_TotalNumberOfEventsSeen{connector="shop"}
debezium_metrics_NumberOfEventsFiltered{connector="shop"}
```

**Snapshot status:**
```
debezium_metrics_SnapshotCompleted{connector="shop"}
debezium_metrics_RemainingTableCount{connector="shop"}
```

**Connector status (Kafka Connect REST):**
```bash
curl -s http://kafka-connect:8083/connectors/orders-connector/status | jq '.tasks[].state'
```

### PostgreSQL Replication Slot Monitoring

```sql
-- Alert if any slot retains more than 5 GB of WAL
SELECT slot_name,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS lag,
       active
FROM pg_replication_slots
WHERE pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) > 5 * 1024^3;
```

Add this as a database alert. Page on > 10 GB; stop the connector as a safety valve before disk fills.

### Kafka Consumer Lag

Debezium publishes to Kafka. Downstream consumers may lag behind:

```bash
kafka-consumer-groups.sh \
  --bootstrap-server kafka:9092 \
  --describe \
  --group my-sink-consumer
```

Monitor `LAG` column. Growing lag means consumers cannot keep up with Debezium's publish rate.

## Connector Lifecycle Management

### Pause and Resume

```bash
# Pause — connector stops reading the WAL; slot retains WAL
curl -X PUT http://kafka-connect:8083/connectors/orders-connector/pause

# Resume — connector reads from saved offset
curl -X PUT http://kafka-connect:8083/connectors/orders-connector/resume
```

Prefer pause/resume over stop/start for planned maintenance — the replication slot is not dropped on pause.

### Updating Connector Configuration

```bash
# Update config while connector is running
curl -X PUT http://kafka-connect:8083/connectors/orders-connector/config \
  -H "Content-Type: application/json" \
  -d '{ ... new config ... }'
```

The connector restarts with the new config. Most config changes (heartbeat interval, table list) take effect immediately. Changes to `plugin.name` or `slot.name` require a full reset.

### Resetting a Connector (Full Re-bootstrap)

When you need to re-snapshot from scratch:

```bash
# 1. Delete the connector
curl -X DELETE http://kafka-connect:8083/connectors/orders-connector

# 2. Drop the replication slot (PostgreSQL)
docker compose exec postgres psql -U dbuser -d shop -c \
  "SELECT pg_drop_replication_slot('debezium_orders');"

# 3. (Optional) Clear Kafka offsets for this connector
# Stop all workers, delete the connect-offsets topic partition for this connector,
# then restart — or use a new slot.name to force a clean start

# 4. Re-register with snapshot.mode = initial
curl -X POST http://kafka-connect:8083/connectors \
  -H "Content-Type: application/json" \
  -d '{ "name": "orders-connector", "config": { "snapshot.mode": "initial", ... } }'
```

## High Availability

### Kafka Connect Distributed Mode

Always run Kafka Connect in **distributed mode** in production. Distributed mode:
- Runs multiple workers in a group
- Automatically rebalances connectors when a worker fails
- Stores offsets and configs in Kafka (durable, replicated)

```properties
# connect-distributed.properties
group.id=debezium-connect-cluster
config.storage.topic=debezium_configs
offset.storage.topic=debezium_offsets
status.storage.topic=debezium_status
config.storage.replication.factor=3
offset.storage.replication.factor=3
status.storage.replication.factor=3
```

Run at least 3 workers for HA. 2 workers cannot tolerate a single failure — rebalancing requires a majority.

### Connector Task Parallelism

Most Debezium connectors use a single task (`tasks.max=1`). Log-based CDC is inherently sequential — the WAL is a single ordered stream. Multiple tasks would read the same stream redundantly.

For higher throughput, partition by table: run one connector per database or per set of tables.

## Operational Runbook

### Alert: Connector in FAILED state

```bash
# 1. Check error
curl -s http://kafka-connect:8083/connectors/orders-connector/status | jq '.tasks[].trace'

# 2. Restart the task
curl -X POST http://kafka-connect:8083/connectors/orders-connector/tasks/0/restart

# 3. If restart fails repeatedly, check:
#    - Database connectivity
#    - Replication slot validity (pg_replication_slots)
#    - Kafka connectivity
#    - Disk space on both database host and Kafka brokers
```

### Alert: WAL lag > 10 GB

```bash
# 1. Check Debezium lag metric
# 2. Check connector status — is it RUNNING?
# 3. Check Kafka broker health — are topics writable?
# 4. If connector is running but lag is growing:
#    - Increase Kafka Connect worker heap: KAFKA_HEAP_OPTS="-Xmx4g"
#    - Check for slow queries on PostgreSQL blocking WAL cleanup
# 5. If disk critical: temporarily pause the connector and drop/recreate slot
```

### Alert: Consumer lag growing

```bash
# 1. Identify the lagging consumer group
kafka-consumer-groups.sh --describe --group my-sink-consumer ...

# 2. Scale out consumers (increase partition count first if needed)
# 3. Check if sink is slow (Delta Lake MERGE taking too long? JDBC bottleneck?)
# 4. Tune foreachBatch trigger interval or batch size
```

## Summary: Production Checklist

```
Database
□ wal_level = logical / binlog_format = ROW
□ REPLICA IDENTITY FULL on all monitored tables
□ max_slot_wal_keep_size configured (PostgreSQL 13+)
□ Replication slot lag monitoring alert (> 5 GB warn, > 10 GB critical)

Kafka Connect
□ Distributed mode with 3+ workers
□ Config/offset/status topics with replication.factor = 3
□ Connector status monitoring (RUNNING / FAILED)
□ JMX metrics exported to Prometheus

Kafka
□ Source topics: cleanup.policy = delete (not compact) for CDC topics with deletes
□ Schema history topic: retention.ms = -1 (MySQL only)
□ Topic replication.factor = 3

Sink
□ Idempotent write semantics (upsert, not insert)
□ Consumer lag monitoring
□ Compaction / OPTIMIZE jobs scheduled (Delta Lake / Iceberg)

Operations
□ Runbook for connector failures
□ Runbook for WAL accumulation
□ Schema change procedure documented
□ Tested: full re-bootstrap procedure
```

## Key Takeaways

- Debezium stores position in Kafka's `connect-offsets` topic; the replication slot is the durable position on the database side
- Monitor replication slot WAL retention — unbounded growth fills disk and stops the database
- Run Kafka Connect in distributed mode with 3+ workers for HA
- Design sinks to be idempotent — duplicates occur on connector restart
- Maintain a runbook for connector failure, WAL accumulation, and full re-bootstrap
- Pause (not stop) connectors during planned maintenance to avoid WAL accumulation

---

That wraps up the Debezium series. You now have the foundation to build, operate, and scale a production CDC pipeline — from WAL internals to Delta Lake sinks to production monitoring.
