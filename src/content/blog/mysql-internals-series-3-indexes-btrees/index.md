---
title: "MySQL Internals Series, Part 3: Indexes & B-Trees"
description: "How MySQL indexes work — B-tree structure, clustered vs secondary, covering indexes, adaptive hash indexes, and index fragmentation."
pubDate: 2026-03-16
author: "ifkarsyah"
domain: "Backend"
stack: ["MySQL"]
image:
  src: ./mysql-series.png
  alt: "MySQL Indexes & B-Trees"
---

Indexes are the single most important factor in query performance. But most developers create them via trial-and-error, adding an index whenever a query is slow. Understanding B-tree structure, clustered vs. secondary indexes, and covering indexes transforms you from index-guessing to index-designing.

This part explores how InnoDB's B-trees work, why secondary index lookups require two searches, and how to design indexes that actually help the optimizer.

## B-Tree Basics

InnoDB uses **B-trees** (balanced search trees) for both tables (clustered indexes) and secondary indexes. A B-tree has these properties:

1. **Balanced** — all leaves are at the same depth
2. **Multi-way branching** — each internal node can have many children
3. **Sorted keys** — keys within each node are sorted, enabling binary search
4. **Self-balancing** — insertions/deletions automatically rebalance

A simplified B-tree looks like:

```
                    ┌──────────────────┐
                    │  [40 | 60 | 80]  │ (root)
                    └──────┬───┬───┬───┘
          ┌─────────────────┘   │   │
          │                     │   │
    ┌─────┴─────┐      ┌───────┘   │
    │ [10|20|30]│      │[50]│[70]  │
    └────┬──────┘      └──┬─┴──────┘
         │                │
    leaf nodes with       leaf nodes
    actual data
```

**Key properties:**

- **Node capacity** — limited by page size (16 KB). A typical node has 100-1000 keys depending on key size
- **Search** — logarithmic O(log N), e.g., 50 million rows need ~6 disk accesses
- **Insertion/deletion** — also O(log N), but may trigger node splits/merges

## Clustered Index vs Secondary Indexes

### Clustered Index (the table itself)

In InnoDB, the **clustered index is the table**. It stores:
- Primary key columns
- All user columns
- MVCC metadata (transaction ID, undo pointer)

```sql
CREATE TABLE users (
    id BIGINT PRIMARY KEY,      -- Clustered index key
    email VARCHAR(255),
    name VARCHAR(100),
    age INT
);

-- This creates ONE B-tree:
-- Clustered Index: (id -> email, name, age, mvcc_metadata)
```

Leaf nodes contain full rows. Searching by primary key is fast (one B-tree search).

### Secondary Indexes

Secondary indexes are separate B-trees that store:
- Secondary key columns
- Clustered index key (the primary key)
- NOT other columns

```sql
CREATE INDEX idx_email ON users(email);

-- This creates a second B-tree:
-- Secondary Index: (email -> id)
-- Note: id is appended automatically
```

**Why is this important?** When you query:

```sql
SELECT name FROM users WHERE email = 'alice@example.com';
```

MySQL must:
1. Search the secondary index `(email)` to find the primary key `id`
2. Search the clustered index `(id)` to fetch the row (and get `name`)

This is called a **two-level lookup** or **index + table access**.

## Covering Indexes

A **covering index** contains all the columns needed for a query, eliminating the second lookup:

```sql
CREATE INDEX idx_email_name ON users(email, name);

-- Query the same query:
SELECT name FROM users WHERE email = 'alice@example.com';

-- MySQL now does:
-- 1. Search idx_email_name for (email, name)
-- 2. Done! No second lookup to the clustered index
```

This is called an **index-only scan** or **covered query**. It's much faster because it avoids the second B-tree search.

**Design rule:** For frequently accessed columns, add them to the index via the `INCLUDE` clause (MySQL 8.0.20+):

```sql
-- INCLUDE columns are stored but not used for sorting/filtering
CREATE INDEX idx_email ON users(email) INCLUDE (name, age);

-- Or the old way (adds them to the sort key, but effective):
CREATE INDEX idx_email_name_age ON users(email, name, age);
```

## Composite Indexes and Key Ordering

When you create an index on multiple columns, **order matters**:

```sql
CREATE INDEX idx_email_age ON users(email, age);

-- This index helps:
-- - WHERE email = '...'
-- - WHERE email = '...' AND age > 30
-- - WHERE email = '...' AND age = 30

-- This index does NOT help:
-- - WHERE age > 30  (must scan entire index)
-- - WHERE age = 30 AND email = '...'  (email is 2nd, can't use without email)
```

**Ordering rule (for a WHERE clause with filters):**

1. Put **equality columns first** (used for filtering, don't require range scans)
2. Put **range columns next** (used for range scans)
3. Put **sort columns last** (if you need sorting)

Example:

```sql
-- Query: SELECT name FROM users WHERE email = '...' AND age > 30 ORDER BY created_at
-- Best index: (email, age, created_at)
CREATE INDEX idx_optimal ON users(email, age, created_at);
```

## Adaptive Hash Index

InnoDB has a secret weapon: the **adaptive hash index** (AHI). It's an in-memory hash table (not a B-tree) that speeds up frequently accessed B-tree nodes.

When InnoDB detects that certain B-tree searches are repeated (e.g., lookups by primary key in tight loops), it automatically builds a hash index on hot parts of the B-tree.

```sql
SHOW ENGINE INNODB STATUS\G
-- Look for "Adaptive hash index stats:" section

-- Monitor AHI
SELECT * FROM INFORMATION_SCHEMA.INNODB_METRICS
WHERE NAME LIKE 'adaptive%'\G
```

You can't control AHI directly, but you can disable it if it's consuming too much memory:

```sql
SET GLOBAL innodb_adaptive_hash_index = OFF;
```

## Index Fragmentation

Over time, indexes become **fragmented** — leaf pages are not sequentially stored on disk, and internal pages have gaps. This increases I/O because a B-tree search bounces between scattered pages.

Check fragmentation:

```sql
SELECT
    OBJECT_SCHEMA,
    OBJECT_NAME,
    COUNT_LEAF_PAGES,
    COUNT_LEAF_DELETED,
    RATIO_DELETED
FROM INFORMATION_SCHEMA.INNODB_TABLESPACES_BRIEF
WHERE OBJECT_NAME LIKE 'users%';
```

If `RATIO_DELETED` is high (>10%), rebuild the index:

```sql
-- Full table rebuild (rewrites clustered index + all secondary indexes)
OPTIMIZE TABLE users;

-- Or just rebuild a specific index (faster)
ALTER TABLE users ENGINE=InnoDB;  -- Rebuilds all indexes
```

## Partial Indexes and Invisible Indexes

### Partial Indexes (MySQL 8.0.13+)

Index only rows matching a WHERE condition:

```sql
-- Index only active users (skip millions of inactive rows)
CREATE INDEX idx_email_active ON users(email) WHERE status = 'active';

-- Query must match the condition to use the index
SELECT * FROM users WHERE status = 'active' AND email = '...';
```

### Invisible Indexes

Test removing an index without deleting it:

```sql
-- Make index invisible (optimizer won't use it)
ALTER TABLE users ALTER INDEX idx_email INVISIBLE;

-- Monitor query performance
EXPLAIN SELECT * FROM users WHERE email = '...' \G

-- If performance is bad, make it visible again
ALTER TABLE users ALTER INDEX idx_email VISIBLE;

-- If not needed, delete it
DROP INDEX idx_email ON users;
```

## Practical Index Design

Given this table:

```sql
CREATE TABLE orders (
    id BIGINT PRIMARY KEY,
    user_id BIGINT,
    status VARCHAR(50),
    total_amount DECIMAL(10, 2),
    created_at TIMESTAMP
);
```

**Queries:**

1. `SELECT * FROM orders WHERE user_id = ? ORDER BY created_at DESC`
   → Index: `(user_id, created_at DESC)`

2. `SELECT * FROM orders WHERE status = 'pending' AND created_at > ?`
   → Index: `(status, created_at)`

3. `SELECT COUNT(*) FROM orders WHERE status = 'completed'`
   → Index: `(status)` (or full scan if rare status)

**Final indexes:**

```sql
CREATE INDEX idx_user_date ON orders(user_id, created_at DESC);
CREATE INDEX idx_status_date ON orders(status, created_at);
```

## Key Takeaways

1. **Clustered index is the table** — it stores all columns, secondary indexes only store keys
2. **Secondary index lookups are two-stage** — index search + clustered key lookup
3. **Covering indexes eliminate the second lookup** — put all needed columns in the index
4. **Order matters in composite indexes** — equality first, range second, sort last
5. **Adaptive hash index is automatic** — InnoDB optimizes hot paths without configuration
6. **Fragmentation reduces performance** — use `OPTIMIZE TABLE` when ratio_deleted is high

## Next Steps

In **Part 4**, we'll explore how the MySQL optimizer uses indexes to build execution plans. You'll learn the cost model, statistics, and how to steer the optimizer with hints.

---

**Part 3 complete. Next: [Query Execution & Optimization](/blog/mysql-internals-series-4-query-optimization/)**
