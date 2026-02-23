---
title: "PostgreSQL Internals Series, Part 5: Memory & BufferPool"
description: "How PostgreSQL manages memory — shared buffers, eviction policies, dirty pages, checkpoints, WAL buffers, and optimal sizing."
pubDate: 2026-03-30
author: "ifkarsyah"
domain: "Backend"
stack: ["PostgreSQL"]
image:
  src: ./postgres-series.png
  alt: "PostgreSQL Memory & BufferPool"
---

Memory is the bridge between fast CPUs and slow disks. PostgreSQL uses a **shared buffer pool** to cache pages in RAM. Understand this cache and you'll understand why some queries are fast and others slow, why certain configurations matter, and how to diagnose memory bottlenecks.

This part covers the shared buffer pool, memory allocation, cache efficiency, dirty page flushing, and checkpoints.

## Architecture Overview

PostgreSQL memory is divided into:

```
┌────────────────────────────────────────────────────┐
│ Shared Memory (all connections share)              │
│  • Shared Buffers (cache pages from disk)          │
│  • WAL Buffers (pre-write log entries)             │
│  • Lock Manager, Transaction State, etc.          │
└────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────┐
│ Local Memory (per-backend, per-process)            │
│  • work_mem (hash tables, sorts, temp results)     │
│  • temp_buffers (temporary tables)                 │
│  • maintenance_work_mem (VACUUM, CREATE INDEX)    │
└────────────────────────────────────────────────────┘
```

**Shared buffers** are critical. Everything goes through them: table scans, index lookups, writes.

## Shared Buffers

### Size & Allocation

PostgreSQL allocates a fixed **shared buffer pool** at startup:

```
shared_buffers = 256MB  # Default (usually too small)
```

Common recommendations:
- **Development**: 256MB – 1GB
- **Small server** (1–4 GB RAM): 25% of RAM
- **Large server** (> 32 GB RAM): 15–20% of RAM

```sql
-- Check current setting
SHOW shared_buffers;

-- Change it (requires restart)
ALTER SYSTEM SET shared_buffers = '4GB';
SELECT pg_ctl_start();  -- Restart required
```

**Why not 100%?** PostgreSQL needs memory for:
- Operating system (cache for the shared buffer pool itself)
- Connections (work_mem per connection)
- WAL buffers, lock manager, etc.

Allocation: 1 shared buffer = 8KB (one page). So `shared_buffers = 256MB` allocates 32,768 buffers.

### Buffer Descriptors

Each buffer has a **descriptor** in shared memory:

```c
typedef struct BufferDesc {
    BufferTag tag;          // (database, table/index, block number)
    int freeNext;          // Link to next free buffer
    unsigned refcount;      // # of processes holding a pin on this buffer
    uint32 usage_count;     // Clock sweep counter
    volatile uint32 state;  // Flags (DIRTY, VALID, etc.)
    // ... more fields
} BufferDesc;
```

The descriptor tracks:
- **tag**: Which page is in this buffer (database, relation, block number)
- **refcount**: How many processes are using it (pin count)
- **state**: Flags indicating if the page is dirty, valid, etc.
- **usage_count**: For eviction decisions

### Buffer Lookup

When PostgreSQL needs a page:

```
1. Hash the (database, relation, block) tuple
2. Lookup in buffer hash table
3. If found: Read from shared buffer (cache hit)
4. If not found: Read from disk, allocate a buffer, insert in hash table
```

Hash table lookups are O(1) and very fast — one reason shared buffers are effective.

## Eviction Policy: Clock Sweep

When the buffer pool is full, PostgreSQL evicts a **clean** buffer (not dirty, not pinned):

The **clock sweep algorithm** (simplified LRU):
1. Maintain a clock hand (current position)
2. For each buffer the hand points to:
   - If `usage_count > 0`: Decrement and advance
   - If `usage_count == 0` and not pinned: **Evict this buffer**
   - Advance the hand

This gives each buffer a "second chance" every rotation.

```
Buffers: [1] [1] [1] [2] [3] [0] [0] [0]
         Clock hand ↓
After one pass, hand at [3]:
         [0] [0] [0] [1] [2] [0] [0] [0]
Next eviction candidates: buffers with usage_count == 0
```

**Why clock sweep?** It's O(1) per eviction and doesn't require sorting. Simple and effective.

### Usage Count

When a buffer is **used**, its `usage_count` increments (up to a maximum). Frequently used buffers stay in memory longer.

```sql
-- Buffers are accessed frequently are more "sticky"
SELECT * FROM large_table WHERE id IN (1, 2, 3, 4, 5);
-- These 5 buffers will have high usage_count, unlikely to be evicted
```

## Dirty Pages & Flushing

A page becomes **dirty** when:
- A tuple is inserted
- A tuple is updated
- A tuple is deleted
- An index is modified

Dirty pages must be written to disk **before the page is evicted** (durability guarantee from WAL, Part 6).

**Checkpoint**: The process that flushes all dirty pages to disk.

```sql
CHECKPOINT;  -- Explicit checkpoint
-- Or autovacuum runs one periodically (default every 5 minutes)
```

Monitor checkpoint progress:

```sql
SELECT * FROM pg_stat_database
WHERE datname = 'postgres';
```

Key columns:
- `checkpoints_timed`: Scheduled checkpoints (5 min interval)
- `checkpoints_req`: Requested checkpoints (WAL fills up)
- `checkpoint_write_time`: MS spent writing pages
- `checkpoint_sync_time`: MS spent syncing to disk

## Checkpoint Configuration

```sql
-- Checkpoint parameters
SHOW checkpoint_timeout;     -- Default: 5 min (300 seconds)
SHOW max_wal_size;          -- Default: 1 GB (triggers checkpoint when exceeded)
SHOW checkpoint_completion_target;  -- Default: 0.9 (spread checkpoint over 90% of interval)
```

When either timeout OR `max_wal_size` is exceeded, a checkpoint starts.

**Implications:**
- **Shorter checkpoints** (low `max_wal_size`): More frequent disk I/O, but recovery is faster if crash happens
- **Longer checkpoints**: Less I/O, but longer recovery time if crash happens

**Example tuning for high-throughput write workloads:**

```sql
ALTER SYSTEM SET checkpoint_timeout = '15min';
ALTER SYSTEM SET max_wal_size = '4GB';
ALTER SYSTEM SET checkpoint_completion_target = 0.8;
-- Restart PostgreSQL
```

This delays checkpoints, reducing background I/O during normal operation.

## WAL Buffers

The **write-ahead log (WAL)** records all changes before they're applied to buffers. WAL buffers hold these records in memory:

```sql
SHOW wal_buffers;  -- Default: 16MB
```

Each transaction writes to the WAL buffer, then to the WAL file on disk.

**How it works:**
1. Transaction modifies a page (write to shared buffer, mark dirty)
2. Transaction writes log entry to WAL buffer
3. `fsync()` to disk (durability)
4. Transaction commits
5. (Later) Checkpoint flushes dirty pages to disk

WAL is discussed in detail in Part 6.

## Monitoring Buffer Health

### Cache Hit Ratio

The **cache hit ratio** shows what fraction of page accesses come from buffers (not disk).

```sql
SELECT
    sum(blks_hit) / (sum(blks_hit) + sum(blks_read)) * 100 AS cache_hit_ratio
FROM pg_stat_database
WHERE datname = 'postgres';
```

**Targets:**
- **Online transaction processing (OLTP)**: 99%+ cache hits (most data fits in RAM)
- **Data warehouse (OLAP)**: 90%+ is acceptable (large scans miss cache)

If cache hit ratio is low:
- Increase `shared_buffers`
- Optimize queries to access less data
- Add indexes to reduce full-table scans

### Buffer Usage

Check how many buffers are in use:

```sql
SELECT
    sum(heap_blks_read + heap_blks_hit) / 1000.0 AS total_heap_blocks_in_mb,
    sum(heap_blks_hit) / (sum(heap_blks_hit) + sum(heap_blks_read)) * 100 AS cache_hit_ratio
FROM pg_statio_user_tables;
```

Check which tables consume the most buffer space:

```sql
SELECT
    schemaname,
    tablename,
    heap_blks_read + heap_blks_hit AS total_blocks_accessed,
    heap_blks_hit,
    CASE
        WHEN heap_blks_read + heap_blks_hit = 0 THEN 0
        ELSE heap_blks_hit::float / (heap_blks_hit + heap_blks_read) * 100
    END AS cache_hit_ratio
FROM pg_statio_user_tables
ORDER BY total_blocks_accessed DESC;
```

## Work Memory & Per-Query Memory

Each query operation (sort, hash join, etc.) has a memory budget:

```sql
SHOW work_mem;  -- Default: 4MB
```

For a hash join with 10 million rows:
- Each row = ~64 bytes (avg)
- Total = 10M * 64B ≈ 640 MB
- work_mem = 4 MB

The query **spills to disk** — building a temp file instead of staying in memory. This is slow.

**Solution:** Increase `work_mem`:

```sql
SET work_mem = '256MB';  -- Per operation
SELECT * FROM users u
JOIN large_table l ON u.id = l.user_id
WHERE ...;  -- Hash join now fits in memory
```

**Warning:** work_mem is **per operation per backend**. If you set it to 1GB and have 100 connections, peak memory could be 100GB. Be careful.

```sql
-- Safe approach: increase for specific queries
SET work_mem = '256MB';
EXPLAIN ANALYZE SELECT ... FROM ... JOIN ...;
RESET work_mem;
```

## Maintenance Work Memory

VACUUM, CREATE INDEX, and ALTER TABLE use this:

```sql
SHOW maintenance_work_mem;  -- Default: 64 MB
```

For large tables, increase it:

```sql
ALTER SYSTEM SET maintenance_work_mem = '1GB';
```

Unlike `work_mem`, this is not per operation — only one maintenance operation runs at a time, so it's safer to set high.

## Memory Context Allocator

PostgreSQL has a **memory context** allocator that organizes temporary memory:

```
PortalContext (per cursor)
├── QueryContext (per SQL statement)
│   ├── ExecutionStateContext
│   ├── CacheContext
│   └── ...
├── ExprContext (per expression evaluation)
└── ...
```

Most memory management is automatic. But leaks can occur in:
- Long-running transactions (contexts accumulate)
- Recursive function calls (nesting creates contexts)

Monitor with:

```sql
-- Check transaction duration
SELECT
    pid,
    usename,
    state,
    now() - query_start AS query_duration
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY query_start;
```

Long-running transactions should be investigated and fixed.

## Practical Memory Tuning

### For Small Server (1–4 GB RAM)

```sql
shared_buffers = 512MB          -- 25% of RAM
effective_cache_size = 2GB      -- 50% of RAM
work_mem = 16MB                 -- Per operation
maintenance_work_mem = 256MB    -- For VACUUM, CREATE INDEX
```

### For Medium Server (8–32 GB RAM)

```sql
shared_buffers = 2GB            -- 6–8 GB (not > 25%)
effective_cache_size = 8GB      -- 50% of RAM
work_mem = 32MB                 -- Adjust based on # connections
maintenance_work_mem = 512MB
```

### For Large Server (> 64 GB RAM)

```sql
shared_buffers = 8GB            -- 15–20% of RAM
effective_cache_size = 32GB     -- 50% of RAM
work_mem = 64MB                 -- Adjust for connection count
maintenance_work_mem = 1GB
```

## Key Takeaways

- **Shared buffers** are the primary cache. Size them for your data set (typically 15–25% of RAM).
- **Clock sweep eviction** keeps frequently-used pages in memory longer.
- **Dirty pages** are written during checkpoints. Tune `checkpoint_timeout` and `max_wal_size` based on recovery requirements.
- **Cache hit ratio** should be 90%+. Monitor with `pg_stat_database`.
- **work_mem** per operation can be increased for large queries, but watch connection count * work_mem total.
- **maintenance_work_mem** should be generous; VACUUM and CREATE INDEX benefit from more memory.

## Monitoring Dashboard

Create a memory monitoring query:

```sql
SELECT
    'shared_buffers' AS parameter,
    pg_size_pretty(setting::bigint * 8 * 1024) AS value
FROM pg_settings
WHERE name = 'shared_buffers'

UNION ALL

SELECT
    'cache_hit_ratio',
    ROUND((sum(heap_blks_hit) / (sum(heap_blks_hit) + sum(heap_blks_read)) * 100)::numeric, 2)::text || '%'
FROM pg_stat_database
WHERE datname = 'postgres'

UNION ALL

SELECT
    'long_running_transactions',
    COUNT(*)::text || ' queries > 5 min'
FROM pg_stat_activity
WHERE state != 'idle' AND now() - query_start > interval '5 min';
```

## Next Steps

Memory management keeps data accessible. But what guarantees that data survives a crash? The answer is **WAL** (Write-Ahead Logging) — a log of all changes written to disk before they're applied.

**Part 6** explores WAL: how it works, how crash recovery uses it, and how streaming replication keeps standby servers in sync.

---

**Part 5 complete. Next: [Write-Ahead Logging & Replication](../postgres-internals-series-6-wal-replication/)**
