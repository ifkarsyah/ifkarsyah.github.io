---
title: "MySQL Internals Series, Part 4: Query Execution & Optimization"
description: "How MySQL optimizes queries — cost model, statistics, execution plans, and steering the optimizer with hints."
pubDate: 2026-03-23
author: "ifkarsyah"
domain: "Backend"
stack: ["MySQL"]
image:
  src: ./mysql-series.png
  alt: "MySQL Query Optimization"
---

The MySQL query optimizer is responsible for choosing how to execute a query. Given `SELECT * FROM users WHERE age > 30 AND status = 'active'`, should it scan the table, use the `age` index, use the `status` index, or both? The optimizer estimates the cost of each strategy and picks the cheapest one.

But the optimizer is not always right. Understanding how it works — its cost model, statistics, and limitations — gives you the power to fix bad plans and guide the optimizer when it makes wrong choices.

## The Optimizer: A Quick Overview

The MySQL optimizer executes these steps:

```
SQL Query
    ↓
Parser (syntax check)
    ↓
Preprocessor (semantic validation)
    ↓
Optimizer (cost-based planning)
    ├─ Generate possible execution plans
    ├─ Estimate cost of each plan
    └─ Choose the cheapest
    ↓
Query Executor (executes the chosen plan)
    ↓
Results
```

Our focus is on the **optimizer** — the component that chooses the plan.

## Execution Plans and EXPLAIN

Use `EXPLAIN` to see the optimizer's chosen plan:

```sql
EXPLAIN SELECT * FROM users WHERE age > 30 AND status = 'active'\G
```

Output (simplified):

```
id            1
select_type   SIMPLE
table         users
partitions    NULL
type          ALL
possible_keys age, status
key           NULL
key_len       NULL
ref           NULL
rows          10000
filtered      15
Extra         Using where
```

**Key fields:**

- **type**: How MySQL accesses the table (`ALL` = full scan, `range` = index range, `eq_ref` = unique index lookup, `const` = constant)
- **possible_keys**: Indexes that could be used
- **key**: The index actually chosen (NULL = table scan)
- **rows**: Estimated number of rows examined (not returned)
- **filtered**: Percentage of rows passing the WHERE clause

### Type Values (from fastest to slowest):

1. **const** — Single row match (PK or UNIQUE key)
   ```sql
   SELECT * FROM users WHERE id = 1;  -- const
   ```

2. **eq_ref** — Join via unique key
   ```sql
   SELECT * FROM orders o JOIN users u ON u.id = o.user_id;  -- eq_ref
   ```

3. **ref** — Join via non-unique index
   ```sql
   SELECT * FROM orders WHERE user_id = 123;  -- ref
   ```

4. **range** — Index range scan (BETWEEN, >, <, IN)
   ```sql
   SELECT * FROM users WHERE age BETWEEN 30 AND 40;  -- range
   ```

5. **index** — Full index scan (all keys, no table access)
   ```sql
   SELECT id, email FROM users ORDER BY id;  -- index
   ```

6. **ALL** — Full table scan (slowest)
   ```sql
   SELECT * FROM users;  -- ALL
   ```

## Cost Model and Statistics

The optimizer uses **statistics** about the table to estimate cost:

- **Table size** — row count
- **Index cardinality** — distinct values in the index
- **Data distribution** — histograms of value frequencies

### Histograms

MySQL 8.0 introduced histograms for accurate statistics on non-uniform data:

```sql
-- Create a histogram
ANALYZE TABLE users UPDATE HISTOGRAM ON age, status;

-- View histograms
SELECT * FROM INFORMATION_SCHEMA.COLUMN_STATISTICS
WHERE TABLE_NAME = 'users'\G
```

Without histograms, the optimizer assumes uniform distribution. If your data is skewed (e.g., 99% of users have status='active'), the optimizer may make poor estimates.

### Cost Formula

The optimizer estimates cost roughly as:

```
Cost = (rows_examined * CPU_cost) + (disk_reads * I/O_cost)
```

Default weights (configurable):

- **cpu_cost**: 0.35 per row examined
- **io_cost**: 1.0 per page read

So examining 1000 rows = 350 units, reading 1 page = 1 unit. The optimizer prefers smaller `rows` estimates and fewer disk accesses.

## Why the Optimizer Makes Bad Decisions

### Reason 1: Outdated Statistics

```sql
-- Stats are stale; row count estimate is wrong
-- Rebuild statistics
ANALYZE TABLE users;

-- Check when stats were last updated
SHOW TABLE STATUS WHERE NAME = 'users'\G
```

### Reason 2: Optimizer Limitations

The optimizer has hard-coded heuristics that override the cost model:

- **Range scan limit**: If an index can match >1000 rows, the optimizer may prefer a table scan
- **Full text search**: Often prefers table scan even with indexes
- **Subqueries**: May not correlate properly with outer query
- **UNION**: Uses OR expansion, which can be suboptimal

### Reason 3: Incorrect Cardinality Estimation

Secondary indexes don't store exact cardinality; InnoDB estimates it by sampling pages. Large tables with skewed data get bad estimates.

```sql
-- Check index cardinality
SELECT
    OBJECT_SCHEMA,
    OBJECT_NAME,
    COUNT_DISTINCT
FROM INFORMATION_SCHEMA.INNODB_TABLESPACES_BRIEF
WHERE OBJECT_NAME LIKE 'idx_%';
```

## Steering the Optimizer: Hints and Techniques

### 1. Index Hints (not recommended, but sometimes necessary)

Force the optimizer to use (or avoid) specific indexes:

```sql
-- Force index usage
SELECT * FROM users USE INDEX (idx_age) WHERE age > 30;

-- Ignore an index
SELECT * FROM users IGNORE INDEX (idx_status) WHERE status = 'active';

-- Use index for WHERE, JOIN, and ORDER BY
SELECT * FROM users
WHERE age > 30
ORDER BY created_at
USE INDEX FOR WHERE (idx_age)
USE INDEX FOR ORDER BY (idx_created);
```

### 2. Optimizer Hints (MySQL 5.7+, preferred)

More flexible hints using comments:

```sql
-- Force a specific index
SELECT /*+ INDEX(users idx_age) */ * FROM users WHERE age > 30;

-- Hint to join two tables in a specific order
SELECT /*+ BKA(o) */ * FROM users u
JOIN orders o ON u.id = o.user_id
WHERE u.age > 30;

-- Use HASH join (MySQL 8.0.20+)
SELECT /*+ HASH_JOIN(u, o) */ * FROM users u
JOIN orders o ON u.id = o.user_id;

-- Skip ICP (index condition pushdown) if it's hurting performance
SELECT /*+ NO_ICP(users idx_age) */ * FROM users WHERE age > 30 AND status = 'active';
```

Available hints: `INDEX`, `BKA`, `HASH_JOIN`, `NO_BKA`, `NO_HASH_JOIN`, `DERIVED_MERGE`, `NO_DERIVED_MERGE`, `SEMIJOIN`, `NO_SEMIJOIN`, and more.

### 3. Query Rewriting

Sometimes rewriting the query helps:

```sql
-- Bad: Optimizer doesn't use index due to function
SELECT * FROM users WHERE YEAR(created_at) = 2024;

-- Good: Optimizer uses range index
SELECT * FROM users WHERE created_at >= '2024-01-01' AND created_at < '2025-01-01';

-- Bad: Subquery not optimized
SELECT * FROM orders WHERE user_id IN (SELECT id FROM users WHERE status = 'vip');

-- Good: Explicit JOIN
SELECT o.* FROM orders o
JOIN users u ON u.id = o.user_id
WHERE u.status = 'vip';
```

### 4. STRAIGHT_JOIN

Force left-to-right join order (MySQL 5.0+, deprecated in favor of hints):

```sql
SELECT STRAIGHT_JOIN * FROM users u
JOIN orders o ON u.id = o.user_id;
-- Guarantees: users is joined first, then orders
```

## Analyzing Join Plans

Multi-table queries have different join strategies:

```sql
EXPLAIN FORMAT=JSON
SELECT * FROM users u
JOIN orders o ON u.id = o.user_id
WHERE u.age > 30\G
```

Output shows:

```json
{
  "query_plan": {
    "select#": 1,
    "table": {
      "table_name": "u",
      "access_type": "range",  -- users table: range scan on age index
      "possible_keys": ["idx_age"],
      "key": "idx_age",
      "rows": 100
    },
    "nested_loop": [
      {
        "table": {
          "table_name": "o",
          "access_type": "ref",  -- orders table: ref access via user_id
          "key": "idx_user_id",
          "rows": 5
        }
      }
    ]
  }
}
```

Join strategies:

1. **Nested Loop Join** (always available, but slow for large sets)
   - For each row in `u`, scan all rows in `o` looking for matches

2. **Block Nested Loop Join** (pre-MySQL 8.0.20)
   - Buffer rows from `u`, then scan `o` once per buffer

3. **Hash Join** (MySQL 8.0.20+, preferred for large joins)
   - Hash the smaller table, then scan the larger table

## Practical Optimization Example

**Problem query:**

```sql
SELECT o.id, o.total, u.name FROM orders o
JOIN users u ON u.id = o.user_id
WHERE o.created_at > '2024-01-01' AND u.age > 30
ORDER BY o.created_at DESC
LIMIT 100;

EXPLAIN FORMAT=JSON ... \G
-- Shows: Full table scan on orders, then lookup in users
-- Estimated rows: 100,000 (very high!)
```

**Analysis:**
- `orders` has no index on `created_at` — full scan
- `users` lookup is fast (index on id), but the first step is slow

**Solution:**
1. Add index on `orders(created_at)` or `orders(created_at, user_id)` to help filter
2. Let the optimizer use `users` index for `age > 30` if it helps (add histogram)

```sql
CREATE INDEX idx_orders_created ON orders(created_at DESC, user_id);
ANALYZE TABLE users UPDATE HISTOGRAM ON age;

-- Re-run EXPLAIN
-- Should show: Range scan on orders(created_at), ref access to users(id)
```

## Key Takeaways

1. **EXPLAIN shows the plan** — use `EXPLAIN FORMAT=JSON` for details
2. **Statistics drive optimization** — keep them fresh with `ANALYZE TABLE`
3. **Histograms help with skewed data** — MySQL 8.0+ feature
4. **Hints guide the optimizer** — use `/*+ ... */` comments, not old hint syntax
5. **Join order matters** — left-to-right is joined first, which affects cost
6. **Query rewriting can help** — avoid functions on columns, use explicit JOINs

## Next Steps

In **Part 5**, we'll explore the buffer pool — how MySQL caches pages in memory, evicts old pages, and manages dirty page flushing. Understanding this is critical for tuning memory usage.

---

**Part 4 complete. Next: [Buffer Pool & Memory Management](/blog/mysql-internals-series-5-buffer-pool/)**
