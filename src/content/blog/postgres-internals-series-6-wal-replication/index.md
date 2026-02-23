---
title: "PostgreSQL Internals Series, Part 6: Write-Ahead Logging & Replication"
description: "How PostgreSQL guarantees durability with WAL, recovers from crashes, and replicates to standbys using streaming replication and logical slots."
pubDate: 2026-04-06
author: "ifkarsyah"
domain: "Infrastructure"
stack: ["PostgreSQL"]
image:
  src: ./postgres-series.png
  alt: "PostgreSQL WAL & Replication"
---

The **write-ahead log (WAL)** is PostgreSQL's contract with durability. Before a transaction commits, all changes are written to a log file on disk. If the server crashes, the log is replayed to recover the database to the moment of failure.

This part covers WAL structure, checkpoints, crash recovery, and streaming replication — how PostgreSQL stays reliable and scales read capacity.

## The Problem: Durability Without Flushing Every Page

Flushing every dirty page to disk after every INSERT/UPDATE would be slow. Modern disks can handle ~100 random writes/sec, not the millions of transactions/sec that databases need.

**Solution: Write-Ahead Logging (WAL)**

Before applying any change to a page in shared buffers, PostgreSQL writes a **log entry** to the WAL file. The log entry is **much smaller** than the full page, so it's fast to write and sync to disk.

```
Timeline of transaction T:
1. T begins
2. T inserts row into shared buffer (not yet on disk)
3. T writes WAL entry: "Insert row X into page 42" to WAL buffer
4. T flushes WAL entry to disk (fsync, ~1-10ms)
5. T commits
6. (Later, during checkpoint) Page 42 is flushed to disk
7. (Or immediately if page evicted from buffer pool)
```

The guarantee: If the server crashes after step 5, the WAL file on disk has the log entry. Recovery can replay it.

## WAL File Organization

WAL files live in `pg_wal/` directory:

```bash
ls -la pg_wal/ | head
```

Output:
```
000000010000000000000001
000000010000000000000002
000000010000000000000003
...
```

Each file is 16 MB by default. Filenames encode the timeline and log position.

**Timeline:** Incremented after each failover/recovery. Prevents mixing logs from different versions of the database.

**Log Sequence Number (LSN):** A 64-bit pointer into the WAL stream.

```sql
SELECT pg_current_wal_lsn();  -- Current write position
```

Output: `0/12345678` (read as: file 0, byte offset 0x12345678)

## WAL Record Format

A WAL record has:

```
┌──────────────────────────────┐
│ XLogRecord header (24 bytes) │
│  • prev: previous LSN        │
│  • xact_time: timestamp      │
│  • rmid: resource manager ID │
│  • info: operation type      │
│  • crc: checksum             │
├──────────────────────────────┤
│ Payload (variable)           │
│  • Page image (for HEAP_INSERT)
│  • Redo info (for index ops)
│  • Undo info (rarely used)   │
├──────────────────────────────┤
│ Backup block (optional)      │
│  • Full page write (for crash recovery)
└──────────────────────────────┘
```

Different record types exist:
- `XLOG_HEAP_INSERT`: Insert into heap page
- `XLOG_HEAP_UPDATE`: Update heap page
- `XLOG_HEAP_DELETE`: Delete from heap page
- `XLOG_BTREE_INSERT`: Insert into B-tree index
- `XLOG_CHECKPOINT_ONLINE`: Checkpoint record
- ... many more

## Crash Recovery

When PostgreSQL starts after an unclean shutdown:

```
1. Read the last checkpoint record (from pg_control file)
2. Start at that point in the WAL
3. Replay all log entries from checkpoint to end of WAL
4. Mark database as clean
```

This is **redo recovery**. If a change was logged but the page wasn't flushed, replaying the log re-applies it.

Example:
- Checkpoint at LSN 0/100000, page 42 flushed
- Transaction inserts row into page 42 (not yet flushed), logs at LSN 0/100100
- Server crashes

On restart:
- Read checkpoint record at LSN 0/100000
- Replay WAL entries from 0/100000 to 0/100100
- Insert is re-applied to page 42 (now consistent)

## Checkpoints

A **checkpoint** is a consistency point where all dirty pages are flushed to disk.

Checkpoints serve two purposes:
1. **Reduce recovery time:** After a crash, only replay WAL since the last checkpoint
2. **Prevent WAL growth:** Can discard old WAL files (before the oldest unflushed page)

### Checkpoint Process

```
1. Start checkpoint: Write XLOG_CHECKPOINT_START record
2. Flush all dirty pages to disk
3. Flush metadata (clog, subtrans) to disk
4. Write XLOG_CHECKPOINT_ONLINE record (end of checkpoint)
5. Update pg_control file with checkpoint LSN
```

Monitor checkpoint progress:

```sql
SELECT
    now() - pg_postmaster_start_time() AS server_uptime,
    checkpoints_timed,
    checkpoints_req,
    checkpoint_write_time,
    checkpoint_sync_time
FROM pg_stat_database;
```

### Checkpoint Configuration

```sql
SHOW checkpoint_timeout;          -- Default: 5 min
SHOW max_wal_size;               -- Default: 1 GB
SHOW checkpoint_completion_target;  -- Default: 0.9
```

Checkpoints start when either timeout OR WAL size is exceeded.

**Trade-off:**
- **Frequent checkpoints:** More background I/O, but faster recovery
- **Infrequent checkpoints:** Less background I/O, but slower recovery (more WAL to replay)

Tune for your workload:

```sql
-- High-throughput writes, long acceptable recovery time
ALTER SYSTEM SET checkpoint_timeout = '15 min';
ALTER SYSTEM SET max_wal_size = '4 GB';

-- OLTP with fast recovery requirement
ALTER SYSTEM SET checkpoint_timeout = '5 min';
ALTER SYSTEM SET max_wal_size = '1 GB';
```

## Streaming Replication

PostgreSQL can replicate to **standby** servers using WAL streaming. Standbys:
- Receive WAL entries in real-time
- Replay them to stay in sync
- Can be queried (read-only) in PostgreSQL 9.1+
- Can be promoted to primary if primary fails

### Setup

**On primary:**

```sql
-- Create replication user
CREATE ROLE replicator WITH LOGIN REPLICATION PASSWORD 'secret';

-- Check standby connection
SELECT * FROM pg_stat_replication;
```

**PostgreSQL configuration (postgresql.conf):**

```ini
# Replication settings
max_wal_senders = 10        # Max standby connections
wal_level = replica         # Must be 'replica' or higher
wal_keep_segments = 1024    # Keep 1024 WAL segments (~16 GB)
hot_standby = on            # Allow queries on standby
```

**On standby:**

```bash
# Stop standby (if running)
pg_ctl stop -D /var/lib/postgresql/data

# Copy base backup from primary
pg_basebackup -h primary.example.com -D /var/lib/postgresql/data -U replicator -v -P

# Create recovery config
cat > /var/lib/postgresql/data/recovery.conf << EOF
standby_mode = 'on'
primary_conninfo = 'host=primary.example.com user=replicator password=secret'
EOF

# Start standby
pg_ctl start -D /var/lib/postgresql/data
```

Standby connects to primary and starts streaming WAL.

### Monitoring Replication

**On primary:**

```sql
SELECT
    usename,
    application_name,
    client_addr,
    state,
    sync_state,
    write_lsn,
    flush_lsn,
    replay_lsn
FROM pg_stat_replication;
```

Columns:
- **write_lsn**: LSN written to standby's disk
- **flush_lsn**: LSN flushed to standby's disk
- **replay_lsn**: LSN replayed on standby (applied to database)

**Replication lag:** Distance between primary's current LSN and standby's replay_lsn:

```sql
SELECT
    pg_current_wal_lsn() - replay_lsn AS replication_lag_bytes
FROM pg_stat_replication;
```

Convert to readable format:

```sql
SELECT
    ROUND((pg_current_wal_lsn() - replay_lsn)::numeric / 1024 / 1024, 2) AS lag_mb
FROM pg_stat_replication;
```

### Synchronous Replication

By default, primary **doesn't wait** for standbys to receive/replay WAL (asynchronous).

For **synchronous replication**:

```sql
ALTER SYSTEM SET synchronous_commit = 'remote_apply';
```

Options:
- `off`: Fastest, least safe. Primary doesn't wait.
- `local`: Primary waits for local WAL fsync, doesn't wait for standbys.
- `remote_write`: Primary waits for standby to write WAL to disk.
- `remote_apply`: Primary waits for standby to **replay** WAL (safest, slowest).

**Trade-off:** Synchronous replication guarantees zero data loss but increases latency.

```sql
-- For critical systems
ALTER SYSTEM SET synchronous_commit = 'remote_apply';
ALTER SYSTEM SET synchronous_standby_names = 'standby1, standby2';
```

## Logical Replication & Slots

**Physical replication** copies all changes (byte-for-byte). **Logical replication** sends decoded changes (INSERT/UPDATE/DELETE statements) that can be applied to a different database.

### Logical Slots

A **logical slot** tracks which WAL changes have been consumed by subscribers:

```sql
CREATE PUBLICATION mypub FOR ALL TABLES;

-- On subscriber
CREATE SUBSCRIPTION mysub CONNECTION 'host=primary user=replicator password=secret' PUBLICATION mypub;

-- Monitor slot
SELECT * FROM pg_replication_slots;
```

Columns:
- **slot_name**: Name of the slot
- **slot_type**: 'physical' or 'logical'
- **restart_lsn**: Oldest WAL needed by slot
- **confirmed_flush_lsn**: LSN confirmed consumed (logical)

If a subscriber is slow or offline, its slot retains WAL files until it catches up. Be careful not to let slots fall too far behind (can cause WAL directory to fill up).

Monitor slot lag:

```sql
SELECT
    slot_name,
    slot_type,
    active,
    ROUND((pg_current_wal_lsn() - restart_lsn)::numeric / 1024 / 1024 / 1024, 2) AS lag_gb
FROM pg_replication_slots
WHERE slot_name = 'mysub';
```

## Failover & Promotion

To promote a standby to primary:

```bash
# On standby
pg_ctl promote -D /var/lib/postgresql/data

# Or via SQL
SELECT pg_promote();
```

Steps:
1. Standby stops replaying WAL (reaches consistency)
2. Writes a `XLOG_END_OF_RECOVERY` record
3. Becomes writable primary
4. Old primary continues as standby (if it reconnects)

**Best practice:** Use a high-availability tool (PgBouncer, Patroni, etcd) to automate failover and update client connection strings.

## WAL Archiving

For backup/point-in-time recovery, archive WAL files:

```sql
ALTER SYSTEM SET wal_level = 'archive';
ALTER SYSTEM SET archive_mode = 'on';
ALTER SYSTEM SET archive_command = 'cp %p /archive/%f';
-- Or use a script that uploads to S3, etc.
```

Periodically test recovery:

```bash
# Restore a backup
psql postgres < backup.sql

# Restore from WAL archive to specific point in time
pg_ctl stop
rm pg_wal/*  # Clear current WAL
cp /archive/* pg_wal/
cat > recovery.conf << EOF
recovery_target_timeline = 'latest'
recovery_target_xid = 12345  # Or recovery_target_time
restore_command = 'cp /archive/%f %p'
EOF
pg_ctl start
```

## Key Takeaways

- **WAL** guarantees durability. All changes are logged before being applied to buffers.
- **Checkpoints** flush dirty pages and enable discarding old WAL. Tune for your recovery requirements.
- **Crash recovery** replays WAL from the last checkpoint to restore consistency.
- **Streaming replication** keeps standbys in sync, enabling read scaling and failover.
- **Synchronous replication** guarantees zero data loss but increases latency.
- **Logical slots** track which WAL has been consumed by logical subscribers.
- **WAL archiving** enables point-in-time recovery for backups.

## Monitoring Dashboard

```sql
SELECT
    'wal_size_mb' AS metric,
    ROUND(pg_wal_lsn_diff(pg_current_wal_lsn(), '0/0') / 1024 / 1024)::text
FROM pg_database
WHERE datname = 'postgres'

UNION ALL

SELECT
    'replication_slots_lag_mb',
    ROUND(MAX(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) / 1024 / 1024)::text
FROM pg_replication_slots

UNION ALL

SELECT
    'active_standbys',
    COUNT(*)::text
FROM pg_stat_replication

UNION ALL

SELECT
    'last_checkpoint_ago_min',
    ROUND(EXTRACT(EPOCH FROM (now() - checkpoint_start_time)) / 60)::text
FROM pg_control_checkpoint();
```

## Next Steps

You've learned how PostgreSQL writes durably, survives crashes, and replicates to standbys. But all of this happens through **connections and processes**. How does PostgreSQL manage thousands of concurrent connections? How are connections pooled?

**Part 7** explores PostgreSQL's process model: the postmaster, backend processes, connection pooling, background workers, and resource limits.

---

**Part 6 complete. Next: [Connection Management & Process Model](/blog/postgres-internals-series-7-connections-processes/)**
