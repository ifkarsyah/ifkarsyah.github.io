---
title: "PostgreSQL Internals Series, Part 3: Indexes & B-Trees"
description: "How PostgreSQL indexes work — B-tree structure, scans, deduplication, index types, bloat detection, and when the planner uses them."
pubDate: 2026-03-16
author: "ifkarsyah"
domain: "Backend"
stack: ["PostgreSQL"]
image:
  src: ./postgres-series.png
  alt: "PostgreSQL B-Tree Indexes"
---

Indexes are the primary tool for making queries fast. A sequential table scan reads every tuple; an index scan jumps directly to matching rows. But indexes have overhead: they consume disk space, slow down writes (to maintain them), and can become bloated.

This part explores how B-tree indexes actually work, how the planner decides whether to use them, and why your index might be much larger than you expect.

## B-Tree Basics

PostgreSQL's default index type is **B-tree** (Balanced Tree). Unlike binary trees, B-trees have many children per node, making them cache-efficient.

A B-tree has this structure:

```
                    [50 | 100 | 150]  ← Internal node
                   /      |      \
         [10 | 30]    [60 | 80]   [120 | 130]  [160 | 200]
         /    |    \   /   |  \   /     |     \  /    |   \
    Leaf nodes with actual key → row pointers
```

Each **internal node** contains keys and pointers to children. Each **leaf node** contains keys and pointers to heap tuples (their `(block, offset)` from Part 1).

**Key properties:**
- Balanced: All leaf nodes are at the same depth
- Sorted: Keys are in ascending order within each node
- Branching: Each node can have many children (not just 2)
- Efficient: Search is O(log N) — with 1M keys, at most ~4 nodes visited

## Creating an Index

```sql
CREATE TABLE users (
    id BIGINT,
    name TEXT,
    email TEXT,
    age INT
);

-- Single-column index
CREATE INDEX idx_users_id ON users(id);

-- Multi-column index (composite key)
CREATE INDEX idx_users_name_age ON users(name, age);

-- Partial index (only rows matching WHERE)
CREATE INDEX idx_active_users ON users(id) WHERE age > 18;

-- Covering index (include non-key columns)
CREATE INDEX idx_users_id_with_name ON users(id) INCLUDE (name);
```

## Index Scan Types

The planner has several ways to use an index:

### Index Scan
Lookup keys in the index, get heap `(block, offset)`, fetch from heap.

```sql
EXPLAIN ANALYZE
SELECT * FROM users WHERE id = 42;
```

Output might show:
```
Index Scan using idx_users_id on users  (cost=0.42..8.44)
  Index Cond: (id = 42)
```

**Cost**: Fast index lookup (0.42) + heap fetch (8.44).

### Index-Only Scan
The **covering index** approach. The index contains all columns needed for the query, so no heap fetch is required.

```sql
EXPLAIN ANALYZE
SELECT id, name FROM users WHERE id = 42;
```

With `CREATE INDEX idx_users_id_with_name ON users(id) INCLUDE (name);`:

```
Index Only Scan using idx_users_id_with_name on users  (cost=0.42..0.44)
  Index Cond: (id = 42)
```

**Cost**: Just index lookup (0.42), no heap fetch (0.44 is tiny overhead for page header checks).

Index-only scans are **fast** because:
- No random heap I/O
- Index pages are often cached
- Smaller than heap pages (more keys per page)

### Bitmap Index Scan
Used when multiple indexes are combined or for range scans on columns with low cardinality:

```sql
EXPLAIN ANALYZE
SELECT * FROM users WHERE age > 18 AND age < 65;
```

```
Bitmap Index Scan on idx_users_age  (cost=0.00..X)
  Index Cond: (age > 18) AND (age < 65)

Bitmap Heap Scan on users  (cost=X..Y)
  Recheck Cond: (age > 18) AND (age < 65)
```

The bitmap is a memory-efficient representation of matching heap pages. The planner decides it's faster than an index scan.

### Seq Scan (no index)
If the query matches many rows, a sequential scan is faster than random heap I/O:

```sql
EXPLAIN ANALYZE
SELECT * FROM users WHERE age > 0;
```

Expected:
```
Seq Scan on users  (cost=0.00..X)
  Filter: (age > 0)
```

If the table is small or most rows match, scanning all pages sequentially is faster than jumping around with random I/O.

## B-Tree Maintenance & Splits

As you insert rows, keys are added to leaf nodes. When a leaf fills up, it **splits**:

```
Before split: [10, 20, 30, 40, 50] (full node)
              Insert 35

After split:  [10, 20, 30]    [35, 40, 50]
              Key 35 promoted to parent
```

The middle key is promoted to the parent, and two new nodes are created. This keeps the tree balanced and logarithmic search time.

**Cost of splits:** When a node splits, its parent might also split (cascade up). In rare cases, the root splits, increasing tree depth by 1.

## Composite Indexes

Multi-column indexes are useful for certain queries:

```sql
CREATE INDEX idx_users_name_age ON users(name, age);
```

This index can be used for:
- `WHERE name = 'Alice'` ✓ (leading column)
- `WHERE name = 'Alice' AND age = 30` ✓ (both columns)
- `WHERE age = 30` ✗ (age is not leading)

**Rule:** Indexes can only be used if the leading column(s) are in the WHERE clause.

For queries on both `name` and `age` independently, you need separate indexes:

```sql
CREATE INDEX idx_users_name ON users(name);
CREATE INDEX idx_users_age ON users(age);
```

Or use a covering index if you want one index for both queries:

```sql
CREATE INDEX idx_users_multi ON users(name) INCLUDE (age);
```

## Key Deduplication

PostgreSQL's B-trees use **key deduplication** to save space. When a key is repeated many times, it's stored once with a counter:

```
Before dedup:  [10, 10, 10, 10, 20, 20, 30]
After dedup:   [10 (count=4), 20 (count=2), 30]
```

This reduces index size significantly for columns with low cardinality (many duplicates).

## Other Index Types

PostgreSQL supports several index types beyond B-tree:

### BRIN (Block Range Index)
Summarizes ranges of blocks (e.g., "blocks 0–1000 contain values 1–100"). **Very small** and useful for large, naturally sorted tables.

```sql
CREATE INDEX idx_events_time ON events USING BRIN (event_time);
```

**Use case**: Time-series data. If rows are inserted in time order, BRIN can cover billions of rows with a tiny index.

### Hash
Distributes keys by hash value. **Not recommended** for most queries (no range scans).

```sql
CREATE INDEX idx_users_id ON users USING HASH (id);
```

### GiST (Generalized Search Tree)
Supports geometric data (points, polygons, IP ranges). Complex but powerful.

```sql
CREATE INDEX idx_locations ON places USING GIST (location);
```

### GIN (Generalized Inverted Index)
Optimized for searching within arrays and full-text documents.

```sql
CREATE INDEX idx_tags ON posts USING GIN (tags);
```

## Index Bloat Detection

Like tables, indexes can become bloated with dead space. Monitor index size:

```sql
SELECT
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size,
    idx_scan,
    idx_tup_read,
    idx_tup_fetch
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC;
```

Check if an index is being used:

```sql
SELECT
    indexname,
    idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0;  -- Unused indexes
```

Unused indexes slow down writes. Drop them:

```sql
DROP INDEX CONCURRENTLY idx_unused;  -- CONCURRENTLY = no lock
```

## Rebuilding Bloated Indexes

If an index becomes bloated:

```sql
-- Check index size before
SELECT pg_size_pretty(pg_relation_size('idx_users_id'));

-- Rebuild (non-blocking)
REINDEX INDEX CONCURRENTLY idx_users_id;

-- Check size after (should be smaller)
SELECT pg_size_pretty(pg_relation_size('idx_users_id'));
```

## Practical Example: Query with Index

```sql
CREATE TABLE orders (
    order_id BIGINT,
    customer_id BIGINT,
    order_date DATE,
    total DECIMAL,
    status TEXT
);

INSERT INTO orders VALUES
    (1, 100, '2024-01-01', 50.00, 'completed'),
    (2, 101, '2024-01-02', 75.50, 'pending'),
    (3, 100, '2024-01-03', 100.00, 'completed');

CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_date ON orders(order_date);

-- Query 1: Benefit from idx_orders_customer
EXPLAIN ANALYZE
SELECT * FROM orders WHERE customer_id = 100;

-- Output: Index Scan using idx_orders_customer (cost=0.42..8.44)

-- Query 2: Benefit from idx_orders_date
EXPLAIN ANALYZE
SELECT * FROM orders WHERE order_date = '2024-01-01';

-- Output: Index Scan using idx_orders_date (cost=0.29..8.40)

-- Query 3: Can't use both at once (would need composite index or bitmap scan)
EXPLAIN ANALYZE
SELECT * FROM orders WHERE customer_id = 100 AND order_date = '2024-01-01';

-- Output: Bitmap Index Scan or fallback to one index
```

## When NOT to Index

**Don't create an index if:**
- The column has very low cardinality (few distinct values)
- The query selects most rows (seq scan is faster)
- The column is rarely queried
- The table is small (< 10K rows)
- The index duplicates an existing composite index

**High-maintenance indexes:**
- Multi-column indexes on frequently-updated columns
- Partial indexes with complex predicates (harder to understand)
- Too many indexes on one table (write performance suffers)

## Key Takeaways

- **B-trees are balanced, sorted trees** with O(log N) search time.
- **Index scans** use the index to find rows, then fetch from heap.
- **Index-only scans** avoid heap fetches by including all needed columns in the index.
- **Composite indexes** work best with leading-column filters.
- **Key deduplication** reduces index size for columns with duplicates.
- **BRIN indexes** are tiny and great for large, naturally-sorted tables.
- **Unused indexes** waste space and slow writes. Monitor and drop them.
- **Index bloat** can be fixed with `REINDEX INDEX CONCURRENTLY`.

## Monitoring Indexes

Create a dashboard query to monitor index health:

```sql
SELECT
    schemaname,
    tablename,
    indexname,
    pg_size_pretty(pg_relation_size(indexrelid)) AS size,
    CASE
        WHEN idx_scan = 0 THEN 'UNUSED'
        WHEN idx_tup_read / NULLIF(idx_tup_fetch, 0) > 100 THEN 'INEFFICIENT'
        ELSE 'OK'
    END AS status
FROM pg_stat_user_indexes
ORDER BY pg_relation_size(indexrelid) DESC;
```

## Next Steps

Indexes exist to make queries fast. But the **planner** decides whether to use them. It estimates the **cost** of different execution strategies and picks the cheapest.

**Part 4** dives into the cost model: how PostgreSQL estimates costs, how statistics influence decisions, and why the planner sometimes picks seq scans over indexes.

---

**Part 3 complete. Next: [Query Planning & Optimization](/blog/postgres-internals-series-4-query-planning/)**
