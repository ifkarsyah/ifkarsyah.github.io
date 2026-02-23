---
title: "MySQL Internals Series, Part 6: Binary Logging & Replication"
description: "How MySQL survives crashes and enables replication — binary log format, GTID, crash recovery, and streaming replication."
pubDate: 2026-04-06
author: "ifkarsyah"
domain: "Backend"
stack: ["MySQL"]
image:
  src: ./mysql-series.png
  alt: "MySQL Binary Logging & Replication"
---

Durability and replication both depend on the **binary log** — a ledger of all data modifications. When MySQL crashes, it uses the binary log to recover. When a replica starts, it reads the binary log from the master and applies the same changes.

This part explores binary log format, how MySQL survives crashes with the binary log, how GTID (Global Transaction Identifiers) enable safe replication, and how replicas stay in sync.

## What is the Binary Log?

The binary log records every data-modifying statement (or row changes) in a sequential, durable format:

```
Master MySQL Instance
    ↓
Write-Ahead Logging (WAL)
    ↓
InnoDB Redo Log (fast local recovery)
    ↓
Binary Log (replication + point-in-time recovery)
    ↓
Disk
```

**Key properties:**

- **Sequential** — entries are ordered by time
- **Append-only** — never overwritten, only archived
- **Transactional** — a transaction's changes are grouped atomically
- **Replicated** — sent to replicas in real-time (streaming replication)

## Binary Log Formats

MySQL supports three binary log formats:

### 1. Statement Format (oldest)

Logs the actual SQL statements:

```
# master-bin.000001
| BEGIN
| UPDATE users SET age = 30 WHERE id = 1
| UPDATE users SET age = 31 WHERE id = 2
| COMMIT
```

**Pros:**
- Small file size
- Human-readable for debugging

**Cons:**
- **Non-deterministic functions** (NOW(), RAND(), UUID()) may produce different results on replica
- Replication delays (replica executes the statement, which may be slower than on master)

### 2. Row Format (recommended)

Logs individual row changes with before-and-after values:

```
# master-bin.000001
| WRITE_ROWS for table 'users':
|   id=1, age=30  (inserted)
|   id=2, age=31  (inserted)
| DELETE_ROWS for table 'users':
|   id=1, age=30  (deleted)
| UPDATE_ROWS for table 'users':
|   id=1, age=20 → age=25 (before → after)
```

**Pros:**
- Deterministic — replicates exactly
- Handles non-deterministic functions
- Safe for all data types

**Cons:**
- Larger file size (multiple rows per transaction)
- Slower to write in bulk inserts

### 3. Mixed Format

Uses statement format by default, switches to row format for non-deterministic statements.

**Best practice:** Use **row format** for safety, especially with replication.

## Setting Up Binary Logging

Enable in `my.cnf`:

```ini
[mysqld]
# Enable binary logging
log_bin = /var/log/mysql/mysql-bin
binlog_format = ROW

# Keep logs for 7 days
expire_logs_days = 7

# Optional: Log all queries (slow, for debugging)
log_all_queries = 0
```

Restart MySQL:

```bash
systemctl restart mysql
```

Check status:

```sql
SHOW BINARY LOGS;
-- Lists all binary log files and their sizes

SHOW MASTER STATUS;
-- Shows current binary log file and position

SHOW BINLOG EVENTS IN 'mysql-bin.000001' LIMIT 10;
-- Displays events (transactions) in the log
```

## GTID (Global Transaction Identifiers)

MySQL 5.6+ introduced **GTID** — a unique ID for every transaction, enabling safe replication.

Format: `server_uuid:transaction_number`

Example: `3e11fa47-71ca-11e1-9e33-c80aa9429562:1`

### Why GTID Matters

Without GTID, replication is file + position based:

```sql
-- Master
SHOW MASTER STATUS;
-- File: mysql-bin.000042, Position: 154

-- Replica must know to start at mysql-bin.000042:154
-- Problem: If master crashes and a new master is promoted,
-- finding the right position is error-prone
```

With GTID, replication is **transaction-based**:

```sql
-- Master 1
-- GTID: 3e11fa47:1, 3e11fa47:2, 3e11fa47:3

-- New Master (Master 2)
-- GTID: 9e11fa47:1

-- Replica knows:
-- "Execute all GTIDs except 9e11fa47:1-100"
-- Automatic, no manual position tracking
```

### Enabling GTID

In `my.cnf`:

```ini
[mysqld]
gtid_mode = ON
enforce_gtid_consistency = ON
log_bin = /var/log/mysql/mysql-bin
binlog_format = ROW
```

Verify:

```sql
SELECT @@gtid_mode;       -- ON
SELECT @@enforce_gtid_consistency;  -- ON

SHOW MASTER STATUS;
-- Executed_Gtid_Set: 3e11fa47-71ca-11e1-9e33-c80aa9429562:1-105
```

## Crash Recovery with Binary Log

When MySQL crashes and restarts, it ensures durability:

```
1. Crash occurs mid-transaction
2. MySQL restarts
3. Check for uncommitted transactions in redo log
4. Rollback uncommitted transactions
5. Replay committed transactions from binary log
6. Database is consistent
```

The **2-phase commit protocol** ensures consistency:

```
Phase 1 (Redo): Write to InnoDB redo log
Phase 2 (Binlog): Write to binary log
Commit: Mark committed in InnoDB

On crash:
- If only Phase 1 done: Transaction rolled back (didn't reach binlog)
- If both phases done: Transaction committed (in binlog)
```

This guarantees:
- No data loss for committed transactions
- No replication of uncommitted transactions
- Replica and master always in sync

## Streaming Replication

Replicas receive binary log events in real-time from the master:

```
Master (writes changes to binary log)
    ↓
Binary Log File
    ↓
Replication Thread (reads and sends to replica)
    ↓
Replica (receives and applies)
```

### Setting Up Replication

**On Master:**

```sql
CREATE USER 'repl'@'replica.local' IDENTIFIED BY 'password';
GRANT REPLICATION SLAVE ON *.* TO 'repl'@'replica.local';

SHOW MASTER STATUS;
-- File: mysql-bin.000001
-- Position: 154
-- Executed_Gtid_Set: ...
```

**On Replica:**

```sql
CHANGE REPLICATION SOURCE TO
    SOURCE_HOST = 'master.local',
    SOURCE_USER = 'repl',
    SOURCE_PASSWORD = 'password',
    SOURCE_AUTO_POSITION = 1;  -- Use GTID

START REPLICA;

SHOW REPLICA STATUS;
-- Seconds_Behind_Master: 0  (in sync)
-- Replica_IO_Running: Yes
-- Replica_SQL_Running: Yes
```

### Monitoring Replication Lag

```sql
SHOW REPLICA STATUS\G

-- Key fields:
-- Seconds_Behind_Master: How many seconds behind (NULL = not running)
-- Replica_IO_Running: Receiving events from master
-- Replica_SQL_Running: Applying events locally
```

If replication is slow:
- Master is writing too fast (increase replica's parallelism)
- Replica is slow (index missing, bad query plan)
- Network latency

## Multi-Source Replication and Group Replication

### Multi-Source Replication (MySQL 5.7+)

One replica reads from multiple masters:

```sql
CHANGE REPLICATION SOURCE TO
    SOURCE_HOST = 'master1.local',
    SOURCE_USER = 'repl',
    FOR CHANNEL 'master1';

CHANGE REPLICATION SOURCE TO
    SOURCE_HOST = 'master2.local',
    SOURCE_USER = 'repl',
    FOR CHANNEL 'master2';

START REPLICA FOR CHANNEL 'master1';
START REPLICA FOR CHANNEL 'master2';
```

Useful for aggregating data from multiple databases.

### Group Replication (MySQL 5.7+)

All replicas are also writable masters. Changes are synchronized via a distributed algorithm:

```
Master 1 ↔ Master 2 ↔ Master 3
(all three can accept writes)
```

Benefits:
- No single master failure point
- All servers are identical (active-active)
- Automatic failover

Downside:
- More complex setup
- Potential for write conflicts

## Binary Log Purging and Retention

Binary logs accumulate over time. Configure retention:

```ini
[mysqld]
# Keep logs for 7 days
expire_logs_days = 7

# Or explicitly set max size
binlog_expire_logs_seconds = 604800  -- 7 days
max_binlog_size = 1073741824        -- 1 GB per file
```

Manual purge (dangerous — verify replicas have caught up first):

```sql
-- Purge logs older than a specific date
PURGE BINARY LOGS BEFORE '2024-01-01';

-- Purge a specific log file (everything before it)
PURGE BINARY LOGS TO 'mysql-bin.000010';
```

## Backup and Point-in-Time Recovery

Binary logs enable **point-in-time recovery** (PITR) — restore to any moment:

```bash
# Full backup at time T0
mysqldump -u root -p --all-databases > backup.sql

# Later, at time T1, a bad query deletes all users
DELETE FROM users;  -- oops!

# Restore from backup and replay binary log
mysql -u root -p < backup.sql

# Extract and apply only safe transactions from binlog
mysqlbinlog mysql-bin.000001 \
  --stop-datetime='2024-01-15 14:00:00' | \
  mysql -u root -p
```

## Key Takeaways

1. **Binary log records all changes** — enables replication and durability
2. **Row format is safer than statement format** — deterministic replication
3. **GTID enables automatic failover** — no manual position tracking
4. **2-phase commit ensures consistency** — no data loss on crash
5. **Replication lag is common** — monitor and optimize replica hardware
6. **Binary logs enable point-in-time recovery** — keep them for backups

## Next Steps

In **Part 7**, the final part, we'll explore connection management and the thread model — how MySQL handles concurrent connections, resource limits, and why connection pooling matters.

---

**Part 6 complete. Next: [Connection Management & Thread Model](/blog/mysql-internals-series-7-connections-threads/)**
