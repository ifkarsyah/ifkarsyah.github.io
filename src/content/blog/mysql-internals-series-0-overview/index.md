---
title: "MySQL Internals Series, Part 0: Overview"
description: "A roadmap through MySQL 8.4 LTS internals — from storage engines to replication. Why understanding the engine matters and what you'll learn."
pubDate: 2026-02-23
author: "ifkarsyah"
domain: "Backend"
stack: ["MySQL"]
image:
  src: ./mysql-series.png
  alt: "MySQL Internals Overview"
---

MySQL is the world's most popular open-source relational database. Its simplicity, reliability, and performance have made it the default choice for web applications, microservices, and cloud platforms. But most developers treat it as a black box — tuning via trial-and-error or copy-pasting `my.cnf` settings without understanding what they actually do.

This series changes that. Over the next 8 weeks, we'll open the hood and examine how MySQL actually works: how InnoDB stores data on disk, how transactions are isolated using MVCC, how the query optimizer picks execution strategies, and how binary logging survives crashes and enables replication.

**Why does this matter?**

- **Debugging performance issues** requires understanding the query optimizer and buffer pool, not just adding indexes
- **Capacity planning** demands knowledge of memory layout, page eviction policies, and I/O patterns
- **Replication architecture** (master-slave, group replication, geo-distribution) depends on understanding binlog format and GTID
- **Tuning MySQL** in production is impossible without grasping what `innodb_buffer_pool_size`, `innodb_flush_log_at_trx_commit`, and other settings actually control
- **Data integrity decisions** (transaction isolation levels, durability guarantees) require understanding MVCC and undo logs

This series assumes you know basic SQL and have used MySQL. You don't need to be a C programmer—we'll focus on observable behavior, system tables, and the implications for your applications.

## What We'll Cover

### Part 1: Storage Engine & InnoDB Basics
How does MySQL actually store a row? InnoDB uses a B-tree structure for tables (clustered index), with pages as the atomic unit of storage. We'll dissect page layout, row format, compression, and the difference between clustered and secondary indexes.

**Key question:** Why is the primary key so important in InnoDB, and what happens without one?

### Part 2: MVCC & Transactions
The secret to MySQL's concurrency is multi-version concurrency control (MVCC), powered by undo logs and transaction IDs. Every row carries visibility metadata that determines which transactions can see it. We'll explore isolation levels, snapshots, the undo buffer, and when purge threads clean up old versions.

**Key question:** How can two transactions see different versions of the same row simultaneously, and how much undo space do I need?

### Part 3: Indexes & B-Trees
Indexes are critical to query performance, but what happens under the hood? We'll examine B-tree structure, clustered vs. secondary indexes, covering indexes for index-only scans, and why index fragmentation matters. Plus, we'll look at adaptive hash indexes — a MySQL secret weapon.

**Key question:** When does MySQL use an index, and when will the optimizer scan the table instead?

### Part 4: Query Execution & Optimization
The MySQL query optimizer estimates costs, compares execution plans, and picks one. We'll reverse-engineer the cost model, understand statistics (histograms), and learn how optimizer hints and `EXPLAIN` can help us steer the optimizer when it makes wrong choices.

**Key question:** Why did the optimizer pick a full table scan over your carefully-tuned index?

### Part 5: Buffer Pool & Memory Management
InnoDB's buffer pool is the heart of performance — it caches pages in memory using an LRU-like eviction policy. We'll explore page eviction, dirty page flushing, checkpoints, and how to size the buffer pool for your workload. Understanding this layer is critical for tuning.

**Key question:** How much memory does MySQL actually need, and what happens when you get the buffer pool size wrong?

### Part 6: Binary Logging & Replication
Durability and replication come from the binary log, which records all data changes. We'll examine binlog format (row vs. statement), crash recovery, streaming replication, GTID (Global Transaction Identifiers), and how replicas stay in sync with the master.

**Key question:** How does MySQL survive a power failure without losing committed transactions, and how do replicas know which transactions to apply?

### Part 7: Connection Management & Thread Model
MySQL handles connections via a thread pool, not a forking process model. We'll explore the thread pool architecture, connection handling, resource limits, and why connection pooling is essential for modern applications.

**Key question:** How many connections can a single MySQL server handle, and what breaks first?

## How to Use This Series

Each article is **standalone** — you can read them in any order. But they're designed to flow sequentially, with each part building on concepts from earlier ones.

**To follow along:**
- Install MySQL 8.4 LTS (or use a Docker container)
- Have `mysql` CLI ready
- Create a test database for experiments
- Use `EXPLAIN` and `SHOW ENGINE INNODB STATUS` for inspection

**Code examples** in each article are copy-paste ready. Run them in your own environment to see the actual behavior.

## A Quick Architecture Overview

MySQL's query execution looks like this:

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
           │ Optimizer         │ (cost-based planning, Part 4)
           └────────┬──────────┘
                    │
           ┌────────▼──────────┐
           │ Executor          │ (runs the plan, uses buffer pool in Part 5)
           └────────┬──────────┘
                    │
         ┌──────────▼───────────────┐
         │ Storage Engine (InnoDB)  │ (MVCC in Part 2, B-trees in Part 1)
         │ (Clustered & secondary   │
         │  indexes)                │
         └──────────┬───────────────┘
                    │
         ┌──────────▼───────────────┐
         │ Disk (Binary Log in      │
         │ Part 6, Page Cache)      │
         │ (durable writes)         │
         └───────────────────────────┘
```

Each layer has a story. We'll explore them all.

## What You'll Need

**MySQL 8.4 LTS**: Install from [mysql.com](https://www.mysql.com/downloads/) or run:

```bash
docker run --rm -it -e MYSQL_ROOT_PASSWORD=root -e MYSQL_DATABASE=test mysql:8.4
```

**mysql CLI**: The command-line client.

```bash
mysql -u root -p -e "SELECT VERSION();"
```

**Useful system tables and commands:**
- `SHOW ENGINE INNODB STATUS` — real-time InnoDB metrics
- `INFORMATION_SCHEMA.INNODB_*` tables — detailed InnoDB state
- `EXPLAIN` and `EXPLAIN FORMAT=JSON` — query execution plans
- `SHOW CREATE TABLE` — table structure and indexes

## Key Concepts You'll Learn

- **Pages and rows** — the atomic unit of storage in InnoDB
- **Transaction IDs and visibility** — how MVCC works in MySQL
- **B-trees** — how indexes and tables are structured
- **Cost model** — how the optimizer estimates query cost
- **Buffer pool** — how MySQL caches data in memory
- **Undo logs** — how MySQL maintains old row versions for MVCC
- **Binary log** — how durability and replication work
- **Thread pool** — how MySQL handles concurrent connections

## Next Steps

In **Part 1**, we'll create a test table, examine its internal structure using system tables, and understand how InnoDB stores rows on disk using B-tree pages. You'll see the difference between clustered and secondary indexes and learn why the primary key matters.

Ready to go deep? Let's start with storage.

---

**Part 0 complete. Next: [Storage Engine & InnoDB Basics](/blog/mysql-internals-series-1-innodb-storage/)**
