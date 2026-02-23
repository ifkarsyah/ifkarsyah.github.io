---
title: "MySQL Internals Series, Part 2: MVCC & Transactions"
description: "How MySQL isolates transactions — MVCC, undo logs, transaction IDs, isolation levels, and the purge thread."
pubDate: 2026-03-09
author: "ifkarsyah"
domain: "Backend"
stack: ["MySQL"]
image:
  src: ./mysql-series.png
  alt: "MySQL MVCC & Transactions"
---

The magic behind MySQL's concurrency is **MVCC** — Multi-Version Concurrency Control. Instead of blocking readers while writers modify data, MySQL maintains multiple versions of each row. Every transaction sees a snapshot of the database at a specific point in time, determined by transaction IDs and visibility rules.

This part explores how MVCC works, how undo logs store old versions, what isolation levels actually do, and why the purge thread is critical for cleanup.

## How MVCC Works

Every row in InnoDB has MVCC metadata in its header:

```
Row Header:
┌──────────────────────────────────┐
│ DB_TRX_ID (6 bytes)              │ Transaction ID that created this version
├──────────────────────────────────┤
│ DB_ROLL_PTR (7 bytes)            │ Pointer to undo log record
├──────────────────────────────────┤
│ Flags (delete flag, etc.)        │
├──────────────────────────────────┤
│ (remaining row data)             │
└──────────────────────────────────┘
```

- **DB_TRX_ID**: ID of the transaction that created (or last modified) this version
- **DB_ROLL_PTR**: Pointer to the previous version in the undo log

When a transaction modifies a row:

1. A new version is created with the current transaction ID
2. The old version is not deleted — a pointer to it is stored in the undo log
3. Other transactions see the old version if they started before this transaction
4. The new version is visible only to transactions that started after this transaction

## Transaction IDs and Snapshots

Every transaction gets a monotonically increasing **transaction ID** when it first reads or writes. The transaction uses this ID to determine which row versions are visible.

**Visibility Rules (READ COMMITTED isolation):**

A transaction can see a row version if:
- The version was created by a transaction that committed (TRX_ID < current transaction ID)
- The version was not deleted by a committed transaction
- Or the version was created by the current transaction itself

**Example:**

```
Time  Transaction A (ID=100)    Transaction B (ID=101)
────────────────────────────────────────────────────
T1    START TRANSACTION
T2    SELECT * FROM users;      (sees version created by TRX_ID < 100)
T3                              START TRANSACTION
T4                              UPDATE users SET age = 30 WHERE id = 1
T5                              COMMIT
T6    SELECT * FROM users;      (still sees old version; TRX_ID=101 > 100)
T7    COMMIT
T8                              SELECT * FROM users
                                (now sees version created by TRX_ID=101)
```

Transaction A doesn't see B's changes because B's transaction ID (101) is higher — B started after A. This is the essence of isolation.

## Undo Logs

Old row versions are stored in **undo logs** — sequential logs of undo records. Each undo record stores:

- The modified columns' old values
- A pointer to the previous version
- The transaction ID that created the modification

**Undo segments:**

InnoDB maintains separate undo segments for:
- **INSERT** operations (minimal undo: just the insert marker)
- **UPDATE** and **DELETE** operations (full undo: all modified columns)

Undo logs are stored in dedicated tablespaces (`undo_001`, `undo_002`, etc., or in the system tablespace in older versions).

```sql
-- Check undo space usage
SELECT * FROM INFORMATION_SCHEMA.INNODB_TRXS\G
SELECT * FROM INFORMATION_SCHEMA.INNODB_UNDO_LOGS\G
```

## Transaction Isolation Levels

MySQL supports four isolation levels, determined by what row versions a transaction can see:

### 1. READ UNCOMMITTED

Transactions can see **uncommitted changes** from other transactions (dirty reads). Practically never used.

```sql
SET SESSION TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
START TRANSACTION;
SELECT * FROM users;  -- Sees uncommitted changes from other transactions
```

### 2. READ COMMITTED (default in many systems)

Transactions see only **committed versions**. Phantom reads are possible (rows added by other transactions between two reads).

```sql
SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;
START TRANSACTION;
SELECT * FROM users WHERE age > 30;  -- See committed versions
COMMIT;
```

### 3. REPEATABLE READ (MySQL default)

Transactions see a **snapshot** of all rows that existed when the transaction started. The snapshot is created on the first read, not at START TRANSACTION.

```sql
SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ;
START TRANSACTION;
SELECT * FROM users WHERE age > 30;  -- Creates snapshot
-- Even if other transactions insert/update/delete, this transaction won't see those changes
SELECT * FROM users WHERE age > 30;  -- Same result as first query
COMMIT;
```

This is **snapshot isolation** — the transaction sees a consistent view.

### 4. SERIALIZABLE

Transactions are **serialized** — equivalent to running them one after another. Conflicts cause waits or rollbacks. Rarely used outside of banking systems.

```sql
SET SESSION TRANSACTION ISOLATION LEVEL SERIALIZABLE;
START TRANSACTION;
SELECT * FROM users;  -- Acquires locks on all rows
COMMIT;
```

## The Purge Thread

Over time, undo logs accumulate old versions. The **purge thread** periodically:

1. Checks which transactions are still active
2. Identifies undo records that are safe to delete (no active transaction needs them)
3. Deletes old undo records and reclaims disk space

If you keep a transaction open for a long time, the purge thread can't reclaim space — undo logs grow unbounded.

```sql
-- Check undo space
SHOW ENGINE INNODB STATUS\G
-- Look for "Undo space size:" and "History list length:"

-- Monitor purge progress
SELECT * FROM INFORMATION_SCHEMA.PROCESSLIST WHERE COMMAND = 'InnoDB purge worker';
```

**Best practice:** Close transactions promptly. Long-running transactions (e.g., large batch jobs) should be split into smaller chunks with explicit commits:

```sql
-- Bad: Long transaction
START TRANSACTION;
UPDATE users SET status = 'active' WHERE sign_up_date < '2020-01-01';  -- 1M rows
COMMIT;

-- Better: Smaller chunks
WHILE EXISTS(SELECT 1 FROM users WHERE sign_up_date < '2020-01-01' AND status != 'active' LIMIT 1)
DO
    UPDATE users SET status = 'active' WHERE sign_up_date < '2020-01-01' LIMIT 1000;
    COMMIT;
END WHILE;
```

## Observation: Transaction IDs and Visibility

Create a test scenario to observe MVCC:

```sql
-- Session 1
CREATE TABLE mvcc_test (id INT PRIMARY KEY, value INT);
INSERT INTO mvcc_test VALUES (1, 100);
COMMIT;

-- Session 1: Start transaction and check the value
START TRANSACTION;
SELECT * FROM mvcc_test WHERE id = 1;  -- sees value = 100

-- Session 2 (different connection): Update the row
UPDATE mvcc_test SET value = 200 WHERE id = 1;
COMMIT;

-- Session 1: Still sees the old version
SELECT * FROM mvcc_test WHERE id = 1;  -- still sees value = 100
COMMIT;

-- Now see the new version
START TRANSACTION;
SELECT * FROM mvcc_test WHERE id = 1;  -- sees value = 200
COMMIT;
```

Session 1 doesn't see Session 2's changes because it started first. Once Session 1 commits and starts a new transaction, it sees the new version.

## Comparison: PostgreSQL vs MySQL MVCC

| Aspect | PostgreSQL | MySQL |
|--------|-----------|-------|
| **Metadata** | xmin/xmax on page | DB_TRX_ID on every row |
| **Undo Storage** | Heap pages (CMIN/CMAX) | Dedicated undo tablespace |
| **Cleanup** | VACUUM (active) | Purge thread (background) |
| **Snapshot Creation** | At START TRANSACTION | At first read |
| **Default Isolation** | READ COMMITTED | REPEATABLE READ |
| **Serialization** | Via predicate locking | Via gap locks |

## Key Takeaways

1. **MVCC enables concurrency** — multiple transactions see consistent snapshots
2. **Undo logs store old versions** — they grow if transactions stay open
3. **Isolation levels determine visibility** — REPEATABLE READ is MySQL's default (safer)
4. **Purge thread is critical** — closes transactions promptly to avoid undo bloat
5. **Transaction IDs are monotonic** — higher ID = started after, can't see lower ID's changes

## Next Steps

In **Part 3**, we'll explore how indexes work and why secondary index lookups require two B-tree searches. You'll understand covering indexes and adaptive hash indexes.

---

**Part 2 complete. Next: [Indexes & B-Trees](/blog/mysql-internals-series-3-indexes-btrees/)**
