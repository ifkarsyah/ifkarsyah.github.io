---
title: "PostgreSQL Internals Series, Part 2: Transaction Isolation & MVCC"
description: "How PostgreSQL handles concurrent transactions — xmin/xmax visibility rules, snapshots, isolation levels, and the vacuum process."
pubDate: 2026-03-09
author: "ifkarsyah"
domain: "Backend"
stack: ["PostgreSQL"]
image:
  src: ./postgres-series.png
  alt: "PostgreSQL MVCC Transactions"
---

PostgreSQL's concurrency magic is **MVCC**: Multi-Version Concurrency Control. Instead of locking rows when one transaction reads them, PostgreSQL creates **multiple versions** of the same row. Each transaction sees a snapshot of the database at a specific point in time, determined by visibility rules.

The cost of this concurrency is a cleanup process called **VACUUM**, which removes dead tuples. Understand MVCC and you'll understand why VACUUM is critical and why some queries suddenly slow down.

## The Problem: Isolation Without Locking

Imagine two concurrent transactions:

```
Transaction A                    Transaction B
─────────────────────────────────────────────────
BEGIN;                           BEGIN;
SELECT name FROM users           (no statement yet)
WHERE id = 1;
                                 UPDATE users
                                 SET name = 'Bob'
                                 WHERE id = 1;
(what does A see?)
```

In a naive system, either:
- B locks the row, A waits (blocking)
- A sees B's uncommitted change (dirty read, no good)

PostgreSQL does neither. **B creates a new version of the row.** A continues to see the old version, B sees the new version. Both transactions proceed without blocking.

## Transaction IDs (xid)

Every transaction gets a unique **32-bit transaction ID**. These are assigned in order (1, 2, 3, ..., 4 billion). They're used to track which transaction created/deleted a tuple.

```sql
-- See your current transaction ID
SELECT txid_current();
```

When you `INSERT`, the tuple's **xmin** is set to your xid. When you `DELETE`, the tuple's **xmax** is set to your xid (the tuple isn't physically deleted; it's marked for deletion).

When you `UPDATE`, PostgreSQL:
1. Creates a new tuple with xmin = your xid
2. Sets xmax on the old tuple = your xid
3. Links them with t_ctid (Part 1)

**Key insight:** Deletes and updates are **logical, not physical**. No row is actually removed until VACUUM processes it.

## Visibility Rules: Who Sees What?

Every tuple has:
- **xmin**: xid that created it
- **xmax**: xid that deleted it (0 = not deleted)
- Commit flags in t_infomask

A transaction sees a tuple if:

```
Tuple is visible to transaction T if:
  1. xmin is committed AND xmin < T's snapshot_xmin
  2. xmax is not set (0) OR
     xmax is aborted OR
     xmax is not yet committed OR
     xmax >= T's snapshot_xmin (committed after T started)
```

In plain English:
- **I can see tuples created by transactions that finished before I started.**
- **I can't see tuples deleted by transactions that finished before I started.**
- **I can see tuples even if they're being deleted right now, as long as the delete didn't commit before I started.**

## Snapshots

A **snapshot** captures the state of all transactions when your transaction begins. It contains:

- **xmin**: Smallest xid still running (no active transaction has xid < xmin)
- **xmax**: Highest xid assigned so far + 1
- **active_xids**: List of xids between xmin and xmax that are still running

All tuples created by xids in the active list or beyond xmax are invisible to you. All other committed tuples are visible.

**Example snapshot after 10 transactions (1–10), with 3, 5, 7 still running:**

```
xmin = 1
xmax = 11
active_xids = [3, 5, 7]
```

If you're transaction 8:
- See tuples from 1, 2 (committed before I started)
- Don't see tuples from 3, 5, 7 (still running)
- See tuples from 4, 6 (committed since I started, but created before I did... wait, this is tricky)

Actually, if 4 created its tuple after I started, I won't see it because xid 4 >= my xmin. The rule is: **See tuples where xmin < snapshot_xmin, or xmin is in the snapshot and committed after I started and before the tuple was created... actually, it's complex.**

The rule simplifies to:
- **Committed tuple created before my snapshot_xmin**: Visible
- **Tuple currently being created/deleted**: Depends on the creator's commit status relative to my snapshot

## Isolation Levels

PostgreSQL offers 4 isolation levels. Each has different behavior:

### READ UNCOMMITTED
Actually runs as **READ COMMITTED** (PostgreSQL doesn't have true dirty reads):

```sql
SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;
```

### READ COMMITTED (default)
Each statement sees data committed before the statement started (not the transaction). Vulnerable to non-repeatable reads:

```sql
BEGIN;
SELECT * FROM users WHERE id = 1;  -- Sees version A
-- Meanwhile, another transaction updates the row and commits
SELECT * FROM users WHERE id = 1;  -- Sees version B (different!)
COMMIT;
```

### REPEATABLE READ
All statements in a transaction see the same snapshot (the one taken at `BEGIN`). Vulnerable to phantom reads:

```sql
BEGIN;
SELECT COUNT(*) FROM users WHERE age > 30;  -- Sees X rows
-- Meanwhile, another transaction inserts a row and commits
SELECT COUNT(*) FROM users WHERE age > 30;  -- Sees X+1 rows (phantom read)
COMMIT;
```

(PostgreSQL calls this "serialization failure" and requires retry)

### SERIALIZABLE
Full serialization. Transactions run as if they were serial (one at a time). PostgreSQL uses **Serializable Snapshot Isolation (SSI)** to detect conflicts and abort transactions.

```sql
SET TRANSACTION ISOLATION LEVEL SERIALIZABLE;
-- If a conflict is detected, you get: ERROR: could not serialize access
```

## Example: MVCC in Action

Create a test:

```sql
CREATE TABLE accounts (
    id INT,
    balance INT
);

INSERT INTO accounts VALUES (1, 1000);
```

Now run two transactions concurrently:

**Terminal 1:**
```sql
BEGIN;
SELECT * FROM accounts WHERE id = 1;
-- Result: id=1, balance=1000
-- Now wait for Terminal 2...
```

**Terminal 2:**
```sql
UPDATE accounts SET balance = 500 WHERE id = 1;
COMMIT;
```

**Back to Terminal 1:**
```sql
SELECT * FROM accounts WHERE id = 1;
-- Still shows: id=1, balance=1000
-- Because we're in READ COMMITTED mode and the snapshot predates the update
COMMIT;
```

Inspect the actual tuple versions:

```sql
-- After both transactions commit
SELECT xmin, xmax, balance
FROM accounts;
```

Output:
```
 xmin | xmax | balance
------+------+---------
  100 |  101 |    1000  (old version, xmax=101 means deleted by xid 101)
  101 |    0 |     500  (new version, xmax=0 means still active)
```

Two versions of the row exist. Transaction 100 created the first, transaction 101 deleted it and created the new version.

## Vacuum: Cleanup

VACUUM removes dead tuples (those with xmin from an aborted transaction or xmax from a committed transaction).

The catch: **Vacuum can only remove a tuple if no active transaction might still need it.**

PostgreSQL tracks:

```sql
SELECT
    datname,
    pg_size_pretty(pg_database_size(datname)) AS size
FROM pg_database
WHERE datname = 'your_db';
```

Check how many dead tuples exist:

```sql
SELECT
    schemaname,
    tablename,
    n_live_tup,
    n_dead_tup,
    round(100.0 * n_dead_tup / (n_live_tup + n_dead_tup), 2) AS dead_ratio
FROM pg_stat_user_tables
WHERE n_live_tup > 0
ORDER BY n_dead_tup DESC;
```

Dead tuples waste space. Vacuum physically removes them:

```sql
VACUUM;           -- Removes dead tuples
VACUUM ANALYZE;   -- Also updates table statistics
VACUUM FULL;      -- Rewrites entire table (locks it, avoid in production)
```

**Autovacuum:** PostgreSQL runs VACUUM automatically when dead tuple ratio exceeds a threshold (default 10% or > 50 dead tuples).

```sql
-- Check autovacuum status
SELECT * FROM pg_stat_user_tables
WHERE last_autovacuum IS NOT NULL
ORDER BY last_autovacuum DESC;
```

## Transaction ID Wraparound

Since xids are 32-bit, they wrap around (4 billion transactions). PostgreSQL has a built-in safeguard:

```sql
-- Smallest xid that must still be alive for safety
SELECT datfrozenxid FROM pg_database WHERE datname = 'your_db';
```

If this value gets too old, PostgreSQL forces VACUUM. If you don't run it, the database becomes read-only (prevents xid wraparound corruption).

```
FATAL: database is not accepting commands to avoid wraparound data loss in database "mydb"
```

**Solution:** Run VACUUM frequently (autovacuum should handle this).

## Frozen Tuples

To protect against wraparound, old tuples are **frozen**: their xmin is set to `FrozenTransactionId` (2), which is always considered committed and visible.

```sql
-- Check frozen tuple status
SELECT
    schemaname,
    tablename,
    age(datfrozenxid),
    pg_size_pretty(pg_relation_size(schemaname || '.' || tablename))
FROM pg_tables t
JOIN pg_class c ON c.relname = t.tablename
WHERE schemaname = 'public';
```

## Key Takeaways

- **MVCC creates multiple versions** of the same row instead of locking. Reads never block writes.
- **xmin and xmax** determine tuple visibility. Deletes and updates create new versions, not physical deletions.
- **Snapshots** capture transaction state at `BEGIN`. Each transaction sees a consistent view.
- **Isolation levels** control visibility rules. SERIALIZABLE is strictest; READ COMMITTED is most concurrent.
- **VACUUM cleans up dead tuples.** It's critical for table health and preventing xid wraparound.
- **Autovacuum** should be enabled (and tuned) in production. Monitor dead tuples with `pg_stat_user_tables`.

## Troubleshooting MVCC Issues

**Table bloat:** Too many dead tuples. Check `pg_stat_user_tables.n_dead_tup` and run VACUUM.

**Long-running transactions:** Hold old snapshots, preventing VACUUM. Check `pg_stat_activity` for idle transactions.

```sql
SELECT * FROM pg_stat_activity WHERE state = 'idle in transaction' AND now() - query_start > interval '1 hour';
```

**Query slowdowns after updates:** Dead tuples clutter indexes and tables. Run VACUUM ANALYZE.

## Next Steps

Now you understand how PostgreSQL keeps concurrent transactions isolated without locking. But isolation without performance is useless. When you query 100M rows, PostgreSQL must decide whether to scan the entire table or use an **index**.

This decision is made by the **query planner**, but first it must understand what indexes exist and how they're structured.

**Part 3** explores B-tree indexes: how they're organized, how the planner decides when to use them, and when they become bloated.

---

**Part 2 complete. Next: [Indexes & B-Trees](../postgres-internals-series-3-indexes-btree/)**
