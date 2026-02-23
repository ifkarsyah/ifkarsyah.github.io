---
title: "Debezium Series, Part 1: How CDC Works"
description: "Log-based vs query-based CDC, how PostgreSQL WAL and MySQL binlog work, what Debezium reads, and at-least-once delivery guarantees explained."
pubDate: 2026-02-24
author: "ifkarsyah"
domain: "Streaming"
stack: ["Debezium", "Kafka", "PostgreSQL"]
---

Before configuring a single connector, you need to understand what Debezium is actually reading. CDC is not a Debezium-specific trick — it is a consequence of how databases guarantee durability. Debezium just taps into that mechanism.

## Two Approaches to CDC

### Query-Based CDC (Polling)

The naive approach: periodically query the database for recently changed rows.

```sql
-- Run every 5 minutes
SELECT * FROM orders
WHERE updated_at > :last_checkpoint
ORDER BY updated_at ASC;
```

This works but has three fundamental problems:

1. **Deletes are invisible.** When a row is deleted, there is no `updated_at` to filter on — the row is gone.
2. **Requires an audit column.** Every table needs an `updated_at` maintained by the application. Missed updates (e.g., via direct SQL) are silently dropped.
3. **Latency is baked in.** You cannot poll faster than a few seconds without hammering the database.

### Log-Based CDC

Databases write every change to a **transaction log** before applying it to data files. This is the durability mechanism — if the server crashes mid-write, the log is replayed on restart.

Debezium reads this log directly. The log is:
- **Complete** — every insert, update, and delete is recorded
- **Ordered** — changes appear in commit order
- **Already written** — reading it adds no write overhead to your database

The log has different names depending on the database:
- PostgreSQL: **Write-Ahead Log (WAL)**
- MySQL/MariaDB: **Binary Log (binlog)**
- SQL Server: **Transaction Log**
- MongoDB: **Oplog**

## PostgreSQL WAL

PostgreSQL writes every change to the WAL before modifying heap files. The WAL is primarily a crash-recovery mechanism, but PostgreSQL's **logical replication** feature decodes it into a human-readable stream of row changes.

### Enabling Logical Replication

Two settings are required:

```ini
# postgresql.conf
wal_level = logical          # default is 'replica', must be 'logical'
max_replication_slots = 10   # number of concurrent CDC consumers
max_wal_senders = 10         # connections allowed for replication
```

After changing `wal_level`, a restart is required.

### Replication Slots

A **replication slot** is PostgreSQL's way of tracking how much of the WAL a consumer has read. PostgreSQL retains WAL segments until all slots have consumed them — ensuring no changes are lost even if Debezium goes offline.

```sql
-- Create a logical replication slot (Debezium does this automatically)
SELECT pg_create_logical_replication_slot('debezium', 'pgoutput');

-- Check slot position
SELECT slot_name, confirmed_flush_lsn, pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS lag
FROM pg_replication_slots;
```

**LSN** (Log Sequence Number) is PostgreSQL's WAL cursor — a monotonically increasing position. Debezium stores the last processed LSN as its offset.

### pgoutput

`pgoutput` is the built-in logical decoding plugin (introduced in PostgreSQL 10). It translates internal WAL records into a structured protocol that Debezium understands. Before `pgoutput`, the `decoderbufs` or `wal2json` plugins were required — today, `pgoutput` is the default and requires no extra installation.

```
WAL (binary)  →  pgoutput (logical decoding)  →  Debezium  →  Kafka
```

## MySQL Binlog

MySQL's binary log records every statement or row change depending on the `binlog_format`.

### Configuration

```ini
# my.cnf
server-id         = 1
log_bin           = /var/log/mysql/mysql-bin.log
binlog_format     = ROW        # required for Debezium (not STATEMENT or MIXED)
binlog_row_image  = FULL       # captures before and after images of every row
expire_logs_days  = 10
```

`ROW` format records the actual data values changed, not the SQL statement. This is what Debezium needs — the before and after state of each row.

### GTID Mode (Recommended)

**Global Transaction Identifiers** (GTIDs) uniquely identify each transaction across the replication topology:

```ini
gtid_mode            = ON
enforce_gtid_consistency = ON
```

With GTIDs, Debezium tracks position by transaction ID rather than binlog file + offset. This makes failover and replica promotion safer.

## How Debezium Reads the Log

Debezium runs as a **Kafka Connect source connector**. The sequence for each database change:

```
1. Application writes to PostgreSQL/MySQL
2. Database appends change to WAL/binlog (durability guarantee)
3. Debezium reads the log entry via replication protocol
4. Debezium translates the raw log record into a structured event
5. Event is published to a Kafka topic
6. Debezium commits the offset (LSN or binlog position) to Kafka
```

Steps 5 and 6 are intentionally separate. Debezium publishes to Kafka first, then commits the offset. This ensures that if Debezium crashes between publishing and committing, it will re-read and re-publish the same event on restart.

## At-Least-Once Delivery

Debezium guarantees **at-least-once delivery**: every change will appear in Kafka at least once. It does not guarantee exactly-once.

This means **duplicates are possible** in failure scenarios. Your consumers must handle this:

- **Idempotent writes**: Use upsert semantics (e.g., `INSERT ... ON CONFLICT DO UPDATE`) so processing the same event twice has no effect
- **Deduplication**: Use the event's `ts_ms` + `pos` to detect and discard duplicates
- **Exactly-once with Kafka transactions**: Possible but complex; usually idempotent sinks are simpler

In practice, duplicates are rare — they only occur during Debezium restarts after a failure mid-commit. Most production systems accept at-least-once and use idempotent sinks.

## WAL Retention: A Critical Concern

Because Debezium uses a replication slot, **PostgreSQL will retain WAL segments until Debezium reads them**. If Debezium goes offline for an extended period, WAL accumulates on disk.

```sql
-- Check WAL lag for all slots
SELECT slot_name,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn)) AS lag_size
FROM pg_replication_slots;
```

If a slot falls too far behind and disk fills up, PostgreSQL will stop accepting writes. Set a `max_slot_wal_keep_size` (PostgreSQL 13+) as a safety valve:

```ini
# postgresql.conf
max_slot_wal_keep_size = 10GB
```

This tells PostgreSQL to drop a slot if its retained WAL exceeds 10 GB — the slot is lost but the database stays healthy. Monitor slot lag in production.

## Key Takeaways

- Log-based CDC reads the database transaction log — a durability mechanism that already exists
- PostgreSQL uses WAL + `pgoutput` logical decoding; MySQL uses the binlog with `ROW` format
- Debezium tracks position using LSN (PostgreSQL) or binlog coordinates (MySQL)
- Replication slots prevent WAL from being discarded before Debezium reads it — monitor slot lag
- Debezium provides at-least-once delivery; design your consumers to be idempotent

**Next:** [Setting Up Debezium](/blog/debezium-series-2-setup)
