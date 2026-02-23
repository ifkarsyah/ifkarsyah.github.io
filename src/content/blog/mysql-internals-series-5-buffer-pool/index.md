---
title: "MySQL Internals Series, Part 5: Buffer Pool & Memory Management"
description: "How InnoDB caches pages in memory — buffer pool, LRU eviction, dirty pages, checkpoints, and sizing."
pubDate: 2026-03-30
author: "ifkarsyah"
domain: "Backend"
stack: ["MySQL"]
image:
  src: ./mysql-series.png
  alt: "MySQL Buffer Pool"
---

The **buffer pool** is where InnoDB caches pages in memory. It's the most important performance tuning lever in MySQL — a properly sized buffer pool can reduce disk I/O by orders of magnitude, while a poorly sized one causes constant disk thrashing.

This part explores how the buffer pool works, how pages are evicted, how dirty pages are flushed to disk, and how to size it for your workload.

## What is the Buffer Pool?

The buffer pool is a large in-memory cache divided into **pages** (16 KB each). Every read and write goes through it:

1. **Read**: Check if page is in buffer pool. If not, load from disk and cache it.
2. **Write**: Write to page in buffer pool (the page becomes "dirty"). Later, flush dirty pages to disk.

```
Application
    ↓
Buffer Pool (in-memory cache)
    ↓
InnoDB Storage (on-disk B-trees)
```

Without a buffer pool, every query would hit disk, resulting in 1000x+ latency.

## Buffer Pool Structure

The buffer pool is divided into chunks:

```
┌──────────────────────────────────────────┐
│ Buffer Pool (e.g., 8 GB total)           │
├──────────────────────────────────────────┤
│ Chunk 1 (128 MB)   ┌────────────────────┤
│                    │ Pages (16 KB each) │
│                    │ Free list           │
│                    │ LRU list            │
├──────────────────────────────────────────┤
│ Chunk 2 (128 MB)   │ Pages (16 KB each) │
│                    │ Free list           │
│                    │ LRU list            │
└──────────────────────────────────────────┘
```

Multiple chunks allow **online resizing** (MySQL 5.7+):

```sql
SET GLOBAL innodb_buffer_pool_size = 10 * 1024 * 1024 * 1024;  -- 10 GB
-- Resizing happens in background without restart
```

## LRU Eviction Policy

The buffer pool uses an **LRU (Least Recently Used)** policy to evict old pages when new pages need to be loaded:

```
Newest pages (recently accessed)
    ↓
    │ Page A (accessed 1 sec ago)
    │ Page B (accessed 5 sec ago)
    │ Page C (accessed 1 min ago)  ← Evict this
    │ Page D (accessed 5 min ago)
    │
Oldest pages (rarely accessed)
```

When a page is accessed, it moves to the front (newest). When the buffer pool is full and a new page needs loading, the LRU page at the end is evicted.

### The Old Block and Young Block

To avoid **pollution** (loading a temporary large table that evicts all hot pages), InnoDB divides the LRU into two regions:

```
Young Block (Recently accessed, hot pages)
    │ Page A
    │ Page B
    ├─────────── innodb_old_blocks_pct %
Old Block (Less recently accessed)
    │ Page C
    │ Page D
```

New pages start in the **old block**. Only if they're accessed again (within `innodb_old_blocks_time` milliseconds) are they promoted to the young block.

This prevents a full table scan from evicting all hot data:

```sql
-- Configuration (in my.cnf or SET GLOBAL)
innodb_old_blocks_pct = 37          -- Old block is 37% of LRU
innodb_old_blocks_time = 1000       -- Promote if accessed within 1 sec
```

**Example:**

```sql
-- Assume 1000 pages in buffer pool, all hot
-- You run: SELECT * FROM huge_table;  (5000 pages)

-- Without old/young split: All 1000 hot pages evicted
-- With old/young split: New pages go to old block (370 pages)
-- Hot pages stay in young block if not accessed for >1 sec
```

## Dirty Pages and Flushing

When a row is modified, the page containing it becomes **dirty** (needs to be written to disk). InnoDB tracks dirty pages and flushes them asynchronously.

```
Memory (Buffer Pool)
    │
    ├─ Clean page: [row1, row2, row3]
    ├─ Dirty page: [row1 MODIFIED, row2, row3] ← needs flush
    │
Disk (InnoDB tablespace)
    │
    ├─ [row1, row2, row3] (old version, unchanged)
```

### Flush Mechanisms

**1. Checkpoint Flushes** (background task)

Every N seconds, InnoDB flushes dirty pages to ensure crash recovery doesn't replay too much WAL.

```sql
innodb_flush_interval_time = 0      -- Flush every innodb_flush_log_at_trx_commit action
```

**2. LRU Flushes** (on page eviction)

When evicting a dirty page from the LRU, InnoDB must flush it first (can't discard uncommitted changes).

**3. Adaptive Flushes** (heuristic-based)

InnoDB monitors:
- Rate of dirty page creation (writes)
- Age of oldest dirty page (how long since a checkpoint)

If dirty pages accumulate, it increases flush rate to avoid running out of clean pages.

### Durability and Flush Settings

The `innodb_flush_log_at_trx_commit` setting controls when WAL is flushed to disk:

```sql
-- Most durable (slowest)
innodb_flush_log_at_trx_commit = 1
-- COMMIT flushes WAL to disk. Loss only on disk failure.

-- Good balance (default)
innodb_flush_log_at_trx_commit = 2
-- COMMIT flushes WAL to OS cache, but not disk.
-- Loss on OS crash, power failure.

-- Fast but risky
innodb_flush_log_at_trx_commit = 0
-- Flush every second. Loss up to 1 sec of transactions.
```

Don't change this lightly — it affects data durability.

## Monitoring Buffer Pool

### Current State

```sql
SHOW ENGINE INNODB STATUS\G
```

Look for:

```
-------------------------------------
BUFFER POOL AND MEMORY
-------------------------------------
Total large memory allocated: 2146877440
Dictionary memory allocated: 564831
Buffer pool size   : 131072     -- pages (131072 * 16KB = 2GB)
Free buffers       : 32768      -- free pages
Database pages     : 98304      -- cached pages
Old database pages : 36408      -- in old block
Modified db pages  : 8192       -- dirty pages (need flush)
Pending reads      : 0
Pending writes: LRU 0, flush list 0, single page 0
Pages made young 1234567, not young 987654
youngs/s: 150, non-youngs/s: 100
Pages read 50000000, created 1000000, written 40000000
```

**Key metrics:**
- **Free buffers** / **Buffer pool size** = Free % (should be 10-20% to avoid thrashing)
- **Modified db pages** = Dirty pages (should be <10% of total, else flushing lags)
- **youngs/s, non-youngs/s** = LRU promotion rate (high youngs/s = good, hot data)

### Performance Schema

Get detailed metrics:

```sql
SELECT * FROM PERFORMANCE_SCHEMA.INNODB_BUFFER_PAGE_LRU\G
-- Shows every page in the buffer pool, its position, age, etc.

SELECT * FROM PERFORMANCE_SCHEMA.INNODB_BUFFER_STATS\G
-- Summary stats per pool instance
```

## Sizing the Buffer Pool

The buffer pool should be sized as:

```
Buffer Pool Size = Total RAM - (OS + MySQL threads + connections * thread_stack + temp tables + caches)
```

**Rule of thumb:**

- **Development/testing**: 1-2 GB
- **Small production (< 100GB data)**: 10-20 GB
- **Large production (1TB+ data)**: 50-75% of available RAM

Example for a 256 GB server with 1 TB data:

```sql
-- Allocate 75% to buffer pool, keep 25% for OS and temp space
innodb_buffer_pool_size = 192 * 1024 * 1024 * 1024  -- 192 GB

-- Divide into chunks for better concurrency (one chunk per CPU core, ~100-200M per chunk)
innodb_buffer_pool_instances = 16  -- 16 chunks of 12 GB each
```

### Monitoring Efficiency

**Hit ratio** (percentage of reads satisfied by buffer pool, not disk):

```sql
-- Poor: Cache hit rate < 90%
-- Good: Cache hit rate > 99%

-- Calculate from SHOW ENGINE INNODB STATUS:
hit_ratio = 1 - (pages_read / (pages_read + pages_created))
```

If hit ratio is low:
1. Increase buffer pool size
2. Check for full table scans (expensive queries)
3. Verify indexes are being used

## Dirty Page Flushing Tuning

If you have many dirty pages:

```sql
-- Reduce time between checkpoints (flushes more often)
innodb_checkpoint_age = 2147483647  -- Max checkpoint age

-- Increase flush rate for LRU flushing
innodb_lru_scan_depth = 1024  -- Pages to scan for dirty pages on each LRU sweep

-- Heuristic-based adaptive flushing
innodb_adaptive_flushing = ON
```

## Example: Capacity Planning

**Scenario:** A web app with 500 GB data, 100k QPS peak, 16 GB available RAM after OS.

**Buffer pool sizing:**

```sql
innodb_buffer_pool_size = 12 * 1024 * 1024 * 1024  -- 12 GB (75% of 16GB)
innodb_buffer_pool_instances = 8                   -- 8 chunks of 1.5 GB

-- Performance monitoring shows hit rate:
-- At 100k QPS, if 10k page misses/sec * 16KB = 160 MB/sec to disk
-- Buffer pool hit ratio should be >99.9% to avoid disk saturation
```

## Key Takeaways

1. **Buffer pool is the performance lever** — get it right, and queries fly
2. **LRU eviction with old/young blocks prevents pollution** — temporary scans don't evict hot data
3. **Dirty pages must be flushed to disk** — balance between durability and performance
4. **Hit ratio should be >99%** — if lower, increase buffer pool or optimize queries
5. **Size it to 50-75% of available RAM** — leave headroom for OS and connections

## Next Steps

In **Part 6**, we'll explore binary logging and replication — how MySQL survives crashes and how replicas stay in sync with the master.

---

**Part 5 complete. Next: [Binary Logging & Replication](/blog/mysql-internals-series-6-binlog-replication/)**
