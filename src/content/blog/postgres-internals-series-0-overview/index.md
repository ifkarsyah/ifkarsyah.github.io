---
title: "PostgreSQL Internals Series, Part 0: Overview"
description: "A roadmap through PostgreSQL 18 internals — from storage to replication. Why learning the engine matters and what you'll build."
pubDate: 2026-02-23
author: "ifkarsyah"
domain: "Backend"
stack: ["PostgreSQL"]
image:
  src: ./postgres-series.png
  alt: "PostgreSQL Internals Overview"
---

PostgreSQL is one of the most sophisticated open-source databases. Its reliability, extensibility, and performance have made it a staple in production systems worldwide. But behind every fast query and reliable transaction is an intricate engine — one that most developers treat as a black box.

This series changes that. Over the next 8 weeks, we'll pull back the curtain and examine how PostgreSQL actually works: how it stores data on disk, how it isolates transactions, how the query planner picks the right execution strategy, and how it survives crashes with write-ahead logging.

**Why does this matter?**

- **Debugging performance issues** requires understanding the planner and executor, not just writing faster SQL
- **Capacity planning** demands knowledge of buffers, memory models, and I/O patterns
- **Architecture decisions** (replication strategy, backup approach, schema design) become obvious once you understand the constraints
- **Tuning production PostgreSQL** is impossible without grasping what each setting actually controls

This series assumes you know basic SQL and have used PostgreSQL. You don't need to be a C programmer—we'll focus on observable behavior, system tables, and the implications for your applications.

## What We'll Cover

### Part 1: Page Layout & Storage
How does PostgreSQL actually store a row? We'll dissect page structure, tuple headers, alignment rules, and TOAST (out-of-line storage for large values). You'll learn to inspect pages directly using the `pageinspect` extension.

**Key question:** Why does a simple `INSERT` sometimes take longer than expected?

### Part 2: Transaction Isolation & MVCC
The secret to PostgreSQL's concurrency is multi-version concurrency control (MVCC). Every tuple carries visibility metadata (xmin/xmax) that determines which transactions can see it. We'll explore snapshots, isolation levels, and the vacuum process that cleans up dead tuples.

**Key question:** How can two transactions see different versions of the same row simultaneously?

### Part 3: Indexes & B-Trees
Indexes are critical to query performance, but what happens under the hood? We'll examine B-tree structure, index-only scans, key deduplication, and why your index might be bloated. Plus a tour of other index types (GiST, GIN, BRIN).

**Key question:** When should you use an index, and when will the planner ignore it?

### Part 4: Query Planning & Optimization
The query planner is PostgreSQL's most opaque component. It estimates costs, compares execution strategies, and picks one. We'll reverse-engineer the cost model, understand statistics, and learn how to steer the planner when it makes wrong choices.

**Key question:** Why did the planner pick a sequential scan over your carefully-tuned index?

### Part 5: Memory & BufferPool
PostgreSQL allocates a shared buffer pool in memory and uses an LRU-like eviction policy. We'll explore page eviction, dirty page flushing, checkpoints, and how to size buffers for your workload.

**Key question:** What's the memory footprint of a typical query, and how do buffers affect it?

### Part 6: Write-Ahead Logging & Replication
Durability comes from the write-ahead log (WAL), which records all changes before they hit disk. We'll examine WAL format, crash recovery, streaming replication, and logical replication slots.

**Key question:** How does PostgreSQL survive a power failure without losing committed transactions?

### Part 7: Connection Management & Process Model
PostgreSQL uses a forking process model, not a thread pool. We'll explore the postmaster, backend processes, connection pooling, background workers, and resource limits.

**Key question:** How many connections can a single PostgreSQL server handle, and what breaks first?

## How to Use This Series

Each article is **standalone** — you can read them in any order. But they're designed to flow sequentially, with each part building on concepts from earlier ones.

**To follow along:**
- Install PostgreSQL 18 (or use a Docker container)
- Have `psql` ready
- Enable the `pageinspect` extension for Part 1
- Create a test database for experiments

**Code examples** in each article are copy-paste ready. Run them in your own environment to see the actual behavior.

## A Quick Architecture Overview

PostgreSQL's query execution looks like this:

```
┌─────────────────────────────────────────────────────────────┐
│ SQL Query ("SELECT * FROM users WHERE age > 30")            │
└────────────────────┬────────────────────────────────────────┘
                     │
           ┌─────────▼─────────┐
           │ Parser            │ (syntax check)
           └────────┬──────────┘
                    │
           ┌────────▼──────────┐
           │ Planner/Optimizer │ (cost-based planning, Part 4)
           └────────┬──────────┘
                    │
           ┌────────▼──────────┐
           │ Executor          │ (runs the plan, uses buffers in Part 5)
           └────────┬──────────┘
                    │
         ┌──────────▼───────────────┐
         │ Storage Engine           │ (MVCC in Part 2, pages in Part 1)
         │ (Heap, B-tree indexes)   │
         └──────────┬───────────────┘
                    │
         ┌──────────▼───────────────┐
         │ Disk (WAL in Part 6)      │
         │ (durable writes)          │
         └───────────────────────────┘
```

Each layer has a story. We'll explore them all.

## What You'll Need

**PostgreSQL 18**: Install from [postgresql.org](https://www.postgresql.org/download/) or run:

```bash
docker run --rm -it -e POSTGRES_PASSWORD=postgres postgres:18
```

**psql**: The command-line interface.

```bash
psql -U postgres -c "SELECT version();"
```

**Extensions**: We'll use `pageinspect` (built-in, no install needed) and `pg_stat_statements` for query analysis.

```sql
CREATE EXTENSION pageinspect;
CREATE EXTENSION pg_stat_statements;
```

## Key Concepts You'll Learn

- **Pages and tuples** — the atomic unit of storage
- **xmin/xmax** — how PostgreSQL tracks row visibility
- **B-trees** — how indexes work
- **Cost model** — how the planner estimates query cost
- **Shared buffers** — how PostgreSQL caches data in memory
- **WAL (Write-Ahead Logging)** — how durability is guaranteed
- **Snapshots** — how transactions see a consistent view of data
- **Replication** — how standby servers stay in sync

## Next Steps

In **Part 1**, we'll create a test table, insert data, and use the `pageinspect` extension to look directly at how PostgreSQL stores tuples on disk. You'll see the exact bytes that represent a row and understand why tuple alignment matters for performance.

Ready to go deep? Let's start with storage.

---

**Part 0 complete. Next: [Page Layout & Storage](../postgres-internals-series-1-page-storage/)**
