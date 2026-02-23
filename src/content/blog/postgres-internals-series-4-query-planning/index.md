---
title: "PostgreSQL Internals Series, Part 4: Query Planning & Optimization"
description: "How the planner estimates costs, uses statistics, chooses join strategies, and why it sometimes picks seq scans over indexes."
pubDate: 2026-03-23
author: "ifkarsyah"
domain: "Backend"
stack: ["PostgreSQL"]
image:
  src: ./postgres-series.png
  alt: "PostgreSQL Query Planning"
---

The **query planner** is PostgreSQL's most opaque component. You write SQL; it decides whether to scan the table sequentially or use an index, whether to hash or merge join, and in what order to join tables.

The planner's decision is based on **cost estimates**. But these estimates are only as good as the statistics. Stale statistics lead to bad plans. This part teaches you to understand the cost model and steer the planner when it goes wrong.

## The Cost Model

PostgreSQL's cost estimates are **abstract units**, not milliseconds. They're comparable within a query, but not across queries or systems.

```
Total Query Cost = Sum of (operation costs for all nodes in plan tree)
```

Key operations and their costs:

### Sequential Scan
```
Cost = (# of pages) * seq_page_cost + (# of rows) * cpu_tuple_cost
```

Default values:
- `seq_page_cost = 1.0` (relative cost of reading one page sequentially)
- `cpu_tuple_cost = 0.01` (relative cost of processing one tuple)

For a table with 1,000 pages and 100,000 rows:
```
Cost = (1000 * 1.0) + (100000 * 0.01) = 1000 + 1000 = 2000
```

### Index Scan
```
Cost = index_access_cost + heap_access_cost
```

Where:
- `index_access_cost = (# of index pages) * random_page_cost + (# of index tuples) * cpu_index_tuple_cost`
- `heap_access_cost = (# of heap tuples) * random_page_cost + (# of heap tuples) * cpu_tuple_cost`

Default:
- `random_page_cost = 4.0` (relative cost of random disk I/O, much higher than sequential)
- `cpu_index_tuple_cost = 0.005` (processing an index tuple is cheaper than heap tuple)

For an index on 100 rows spread across 50 heap pages:
```
Cost = (50 * 4.0) + (100 * 0.01) + (100 * 4.0) + (100 * 0.01)
     = 200 + 1 + 400 + 1
     = 602
```

**Comparison:** Seq scan (2000) vs. index scan (602). The planner picks the index.

But if the query matches 80% of rows (80,000 tuples):
```
Index scan cost = 4000 + 0.01 + 3200 + 0.01 ≈ 7200
Seq scan cost = 2000

Planner picks seq scan (2000 < 7200).
```

**Key insight:** Indexes are only worth it if you're selecting a small fraction of rows. Beyond ~5–10%, a seq scan is often faster.

## Statistics: The Foundation

The cost model **requires statistics** to estimate row counts and page accesses.

### ANALYZE
Collects statistics by sampling the table:

```sql
ANALYZE;  -- Analyzes all tables
ANALYZE users;  -- Analyzes just users table
ANALYZE users(name);  -- Analyzes just the name column
```

Statistics are stored in `pg_stat_user_tables` and `pg_statistic`:

```sql
SELECT * FROM pg_stat_user_tables
WHERE relname = 'users';
```

Key columns:
- `n_live_tup`: Estimated live rows
- `n_dead_tup`: Estimated dead rows
- `last_analyze`: When ANALYZE last ran
- `n_mod_since_analyze`: Rows modified since last ANALYZE

Check per-column statistics:

```sql
SELECT * FROM pg_stats
WHERE tablename = 'users' AND attname = 'age';
```

Columns:
- `null_frac`: Fraction of NULLs
- `avg_width`: Average column width (bytes)
- `n_distinct`: Estimated distinct values (negative = fraction)
- `correlation`: Correlation between physical and logical order (-1 to 1)
- `histogram_bounds`: Sample of values (for range estimates)

### Selectivity

The **selectivity** of a WHERE clause is the fraction of rows that match.

For `WHERE age = 30`:
```
Selectivity = 1 / n_distinct = 1 / 100 = 0.01 (1%)
Estimated rows = 100,000 * 0.01 = 1,000
```

For `WHERE age > 30`:
```
Selectivity ≈ 0.5 (assumes uniform distribution)
Estimated rows = 100,000 * 0.5 = 50,000
```

For `WHERE age > 30 AND status = 'active'`:
```
Selectivity = 0.5 * 0.1 = 0.05 (5%)
Estimated rows = 100,000 * 0.05 = 5,000
```

These estimates guide the planner. If estimated rows are wildly wrong, the plan is wrong.

### Updating Statistics

Autovacuum runs ANALYZE automatically:

```sql
-- Check autovacuum status
SELECT * FROM pg_stat_user_tables
WHERE last_autovacuum IS NOT NULL
ORDER BY last_autovacuum DESC;
```

For tables with frequent writes, autovacuum might not keep up. Manually update:

```sql
ANALYZE users;
ANALYZE users(age);  -- Just one column
```

For critical tables, disable autovacuum and schedule a periodic ANALYZE:

```sql
ALTER TABLE users SET (
    autovacuum_enabled = false,
    autovacuum_analyze_scale_factor = 0,
    autovacuum_analyze_threshold = 0
);

-- Then ANALYZE in a cron job or maintenance window
```

## Understanding EXPLAIN ANALYZE

EXPLAIN shows the plan (and costs). EXPLAIN ANALYZE **executes** the query and shows actual vs. estimated.

```sql
EXPLAIN ANALYZE
SELECT * FROM users WHERE age > 30;
```

Output:
```
Seq Scan on users  (cost=0.00..1500.00 rows=50000 width=128)
  Filter: (age > 30)
  Rows Removed by Filter: 50000

Planning time: 0.123 ms
Execution time: 45.231 ms
```

Interpretation:
- **Estimated cost**: 0.00 to 1500.00 (seq scan costs)
- **Estimated rows**: 50,000 (matches 50% of 100,000)
- **Actual rows**: 50,000 (estimate was perfect!)
- **Execution time**: 45 ms (actual wall-clock time)

When estimates are wildly off:

```sql
EXPLAIN ANALYZE
SELECT * FROM users WHERE age > 30 AND status = 'active';
```

```
Seq Scan on users  (cost=0.00..1500.00 rows=50000 width=128)
  Filter: (age > 30) AND (status = 'active')
  Rows Removed by Filter: 95000

Planning time: 0.099 ms
Execution time: 123.456 ms
```

**Problem:** Estimated 50,000 rows, but only 5,000 matched. Why?

**Likely cause:** Status is correlated with age (e.g., younger users are more likely to be 'active'). The planner assumed independence and overestimated.

**Fix:** ANALYZE more frequently or adjust selectivity:

```sql
ANALYZE users;

-- Or manually set statistics
ALTER TABLE users ALTER COLUMN status SET STATISTICS 100;
ANALYZE users(status);
```

Higher STATISTICS value means PostgreSQL samples more values to detect correlations.

## Join Strategies

For joins, the planner chooses among three strategies:

### Nested Loop Join
For each row in the outer table, scan the inner table.

```sql
EXPLAIN ANALYZE
SELECT u.name, o.order_id
FROM users u
JOIN orders o ON u.id = o.user_id
WHERE u.age > 30;
```

```
Nested Loop  (cost=0.29..10000.00)
  -> Seq Scan on users u  (cost=0.00..100.00)
      Filter: (age > 30)
  -> Index Scan using idx_orders_user_id  (cost=0.29..100.00)
      Index Cond: (user_id = u.id)
```

**Cost**: For each of 5,000 filtered users, scan the index (cost 100 each) = 5,000 * 100 = 500,000.

**When**: Useful when the outer table is small or inner table has a good index.

### Hash Join
Build a hash table of the inner table, then probe with outer table rows.

```
Hash Join  (cost=100.00..5000.00)
  Hash Cond: (u.id = o.user_id)
  -> Seq Scan on users u  (cost=0.00..100.00)
  -> Hash  (cost=50.00..50.00)
      -> Seq Scan on orders o  (cost=0.00..50.00)
```

**Cost**: Build hash table (50) + scan outer table (100) + probe (5,000 * 0.01) ≈ 200.

**When**: Both tables are medium-sized, no good indexes, or you're joining on non-indexed columns. Hash join is very fast if the hash table fits in `work_mem`.

### Merge Join
Both tables are sorted by join key; merge them like merging two sorted lists.

```
Merge Join  (cost=500.00..600.00)
  Merge Cond: (u.id = o.user_id)
  -> Sort  (cost=200.00..225.00)
      -> Seq Scan on users u  (cost=0.00..100.00)
  -> Sort  (cost=300.00..350.00)
      -> Seq Scan on orders o  (cost=0.00..50.00)
```

**Cost**: Sort both tables + merge ≈ 600.

**When**: Tables are large, already sorted (or index exists), and you want to avoid high memory usage.

## Join Reordering

For three-way joins, the planner tries different orderings:

```sql
SELECT u.name, o.order_id, l.line_amount
FROM users u
JOIN orders o ON u.id = o.user_id
JOIN order_lines l ON o.order_id = l.order_id
WHERE u.age > 30;
```

The planner might try:
1. `users → orders → order_lines`
2. `users → order_lines → orders` (if it's cheaper)
3. `orders → users → order_lines`

...and picks the cheapest. This is why large joins can take a long time to plan.

## Planner Configuration

Tune the planner's behavior:

### Random Page Cost
Assumes how expensive random disk I/O is relative to sequential:

```sql
SET random_page_cost = 1.1;  -- SSD (fast random I/O)
-- or
SET random_page_cost = 2.0;  -- HDD (slower random I/O)
```

For SSDs, lower this value. The planner will favor index scans more.

### Work Memory
Hash tables and sorts use this memory per operation:

```sql
SET work_mem = '256MB';  -- Per operation (default: 4MB)
```

Larger work_mem lets hash joins avoid spilling to disk. But be careful: if you have 10 concurrent operations, memory usage = 10 * 256MB.

### Effective Cache Size
Tells the planner how much of the table might be cached in RAM:

```sql
SET effective_cache_size = '8GB';
```

Higher values encourage index scans (assumes data is cached). Lower values encourage seq scans.

## Custom Query Hints

PostgreSQL doesn't have `/*+ HINT */` syntax like Oracle. Instead, use planner configuration:

**Force seq scan (disable index):**
```sql
SET enable_indexscan TO off;
SELECT * FROM users WHERE id = 42;
RESET enable_indexscan;
```

**Force hash join:**
```sql
SET enable_mergejoin TO off;
SET enable_nestloop TO off;
SELECT u.*, o.* FROM users u JOIN orders o ON u.id = o.user_id;
RESET enable_mergejoin;
RESET enable_nestloop;
```

**Prefer seq scan for this query (without disabling globally):**
```sql
SET work_mem = '1MB';  -- Force hash join to spill, making seq scan attractive
SELECT * FROM users WHERE age > 30;
RESET work_mem;
```

## Plan Caching

PostgreSQL caches query plans:

```sql
-- View cached plans
SELECT * FROM pg_prepared_statements;

-- View statement statistics
SELECT * FROM pg_stat_statements
ORDER BY mean_exec_time DESC;
```

**Plan caching issue:** If you PREPARE a query and then table statistics change, PostgreSQL might reuse a stale plan.

Solution: Set `plan_cache_mode`:

```sql
-- Re-plan every execution (slower, but always optimal)
SET plan_cache_mode = 'always_custom';

-- Let PostgreSQL decide (default)
SET plan_cache_mode = 'auto';
```

## Key Takeaways

- **Cost estimation** is based on `seq_page_cost`, `random_page_cost`, and `cpu_tuple_cost`. Understand these to debug poor plans.
- **Statistics** (from ANALYZE) are critical. Stale statistics lead to bad plans.
- **Selectivity** is the fraction of rows matching a WHERE clause. Estimated selectivity drives cost estimates.
- **EXPLAIN ANALYZE** shows estimated vs. actual. Large differences mean statistics are stale or correlations exist.
- **Join strategies** (nested loop, hash, merge) each have trade-offs. The planner picks the cheapest based on cost estimates.
- **Planner configuration** (`random_page_cost`, `work_mem`, `effective_cache_size`) tunes the model for your hardware.
- **Plan caching** can use stale plans after schema changes. Monitor with `pg_stat_statements`.

## Troubleshooting Bad Plans

1. **Check statistics:** Run `ANALYZE` and re-explain.
2. **Verify selectivity:** Does EXPLAIN estimate match actual? If not, statistics are wrong.
3. **Check correlations:** Use `ALTER TABLE ... ALTER COLUMN ... SET STATISTICS 100; ANALYZE;`
4. **Manually tune:** Set `seq_page_cost`, `random_page_cost`, or `work_mem` for this query.
5. **Force plans (last resort):** Use `enable_*` settings or materialized CTEs to force join order.

## Next Steps

Now you understand how PostgreSQL chooses execution plans. But even the best plan requires **memory** — to cache pages, build hash tables, store sort results.

**Part 5** explores memory management: shared buffers, buffer eviction, checkpoints, and how to size memory for your workload.

---

**Part 4 complete. Next: [Memory & BufferPool](/blog/postgres-internals-series-5-buffer-pool/)**
