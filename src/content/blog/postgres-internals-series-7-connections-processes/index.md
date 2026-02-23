---
title: "PostgreSQL Internals Series, Part 7: Connection Management & Process Model"
description: "PostgreSQL's forking process model, backend lifecycle, connection pooling with PgBouncer, background workers, and resource limits per connection."
pubDate: 2026-04-13
author: "ifkarsyah"
domain: "Backend"
stack: ["PostgreSQL"]
image:
  src: ./postgres-series.png
  alt: "PostgreSQL Process Model & Connections"
---

PostgreSQL uses a **forking process model**: each connection gets its own OS process. This is different from thread-based servers like MySQL or databases that use event loops. Understanding this architecture explains why connection pooling is critical and why resource management matters.

This final part covers the process model, connection lifecycle, pooling strategies, background workers, and resource limits.

## Process Model Overview

PostgreSQL's architecture:

```
┌────────────────────────────────┐
│ postmaster (single process)    │
│  • Listens on port 5432        │
│  • Forks backends on connection│
│  • Manages shared memory       │
│  • Spawns background workers   │
└─────────────┬──────────────────┘
              │
    ┌─────────┼─────────┬─────────┬──────────┐
    │         │         │         │          │
   Backend   Backend   Backend   WAL Sender  Autovacuum
   (PID 1)   (PID 2)   (PID 3)   (PID 4)    Launcher
    │         │         │         │          │
   (conn1)  (conn2)   (conn3)  (replication)
```

Each connection = one backend process.

**Why forking?**
- Simple isolation: Each process has its own memory space
- Stability: One crash doesn't affect other connections
- Scalability: Each process can use multiple CPU cores

**Downside:** Process overhead. Thousands of connections = thousands of processes = high memory usage.

## The Postmaster

The **postmaster** is PostgreSQL's "master" process:

```bash
# Start PostgreSQL
pg_ctl start

# View postmaster process
ps aux | grep postgres | grep postmaster
# Output: postgres 1234  0.0  0.1 ... /usr/lib/postgresql/bin/postgres -D /var/lib/postgresql/data
```

The postmaster:
1. Reads `postgresql.conf` and validates it
2. Initializes shared memory (buffers, locks, etc.)
3. Starts background processes (autovacuum, WAL writer, checkpoint process)
4. Listens on port 5432 (default)
5. Waits for connections

When a connection arrives:
```c
accept() incoming connection
fork() to create new backend process
exit() parent (postmaster continues waiting)
backend process: authenticate, initialize transaction state, run queries
```

## Backend Process Lifecycle

When you connect via `psql`:

```
1. postmaster accepts connection
2. postmaster forks a backend process
3. Backend performs authentication (password check)
4. Backend initializes local state:
   - Allocates backend's private memory (work_mem, temp_buffers)
   - Initializes transaction state
   - Loads configuration (GUCs per user/database/role)
5. Backend enters main loop:
   - Read query from client
   - Parse → Plan → Execute
   - Send results
   - Repeat until client closes
6. Backend exits, cleans up
```

### Backend Memory

Each backend process allocates memory for:

```
├── Code segment (shared, read-only)
├── Data segment
│   ├── Global state
│   ├── Backend-local state
│   ├── Memory contexts (QueryContext, ExprContext, etc.)
│   ├── work_mem (sort/hash buffers)
│   └── temp_buffers (temporary table buffers)
└── Stack (for function calls)
```

Typical backend size: 5–10 MB minimum. With `work_mem = 256MB`, can be much larger.

**Implication:** 1,000 connections × 10 MB = 10 GB. Not counting shared memory.

Monitor backend memory:

```sql
SELECT
    pid,
    usename,
    application_name,
    state,
    pg_size_pretty(CASE WHEN query != '<idle>' THEN query_start ELSE NULL END::text::bigint) AS query_duration
FROM pg_stat_activity
ORDER BY pid;
```

Actually, use a more practical query:

```sql
SELECT
    usename,
    application_name,
    COUNT(*) AS connections,
    pg_size_pretty(SUM(COALESCE(backend_start, now()) - now())::bigint) AS approx_memory
FROM pg_stat_activity
GROUP BY usename, application_name;
```

## Connection Limits

PostgreSQL has a **max_connections** setting:

```sql
SHOW max_connections;  -- Default: 100
```

Increase for applications with many concurrent users:

```sql
ALTER SYSTEM SET max_connections = 500;
-- Requires restart
pg_ctl restart
```

**System limits:**
- Each backend needs an OS file descriptor
- Each backend allocates stack space (typically 1–8 MB)
- Each backend gets PID (OS limit on PIDs)

Check system limits:

```bash
# Max file descriptors
ulimit -n

# Max processes
ulimit -u

# Typical: need (max_connections + 10) file descriptors and processes
```

### Connection Pool Reservation

Reserve some connections for administrative tasks:

```sql
SHOW superuser_reserved_connections;  -- Default: 3
```

So if `max_connections = 100`, only 97 are available to regular users. This ensures the superuser can always connect to diagnose problems.

## Per-Connection Resource Limits

### statement_timeout
Abort queries that run longer than this:

```sql
SET statement_timeout = '30s';
SELECT * FROM huge_table WHERE expensive_calculation();
-- If query > 30s, aborted
```

### temp_file_limit
Prevent queries from creating huge temp files:

```sql
SET temp_file_limit = '1GB';
```

If a query's sort/hash exceeds 1 GB of temp space, it's aborted.

### idle_in_transaction_session_timeout
Disconnect idle transactions (holding locks, preventing VACUUM):

```sql
SET idle_in_transaction_session_timeout = '5min';

BEGIN;
-- Do something
-- Then wait > 5 min without committing
-- Connection closed
```

### client_connection_check
Periodically check if client is still connected (useful for flaky networks):

```sql
SET tcp_keepalives_idle = 60;  -- Check every 60s
```

## Connection Pooling: The Solution

Running thousands of backend processes is expensive. **Connection pooling** maintains a pool of idle connections and reuses them:

```
Application
     │
     ├─ req1 ──→ [Connection Pool]
     │              │
     ├─ req2 ──→    ├─ [idle backend 1]
     │              ├─ [idle backend 2]
     └─ req3 ──→    ├─ [backend in use]
                    └─ [idle backend 4]
```

Instead of creating a new process per request, the pool assigns an idle backend. When the query finishes, the backend returns to the pool.

### PgBouncer

The most popular PostgreSQL pooler is **PgBouncer**:

```bash
# Install
apt-get install pgbouncer

# Configure /etc/pgbouncer/pgbouncer.ini
[databases]
mydb = host=localhost port=5432 dbname=mydb

[pgbouncer]
pool_mode = transaction
listen_port = 6432
max_client_conn = 10000
default_pool_size = 25
reserve_pool_size = 5
```

**pool_mode** options:
- **session**: Connection stays with client for duration of session (slower, simpler)
- **transaction**: Connection returns to pool after each transaction (faster, default)
- **statement**: Connection returns after each statement (fastest, but no transactions spanning statements)

Start PgBouncer:

```bash
pgbouncer -d /etc/pgbouncer/pgbouncer.ini
```

Clients connect to PgBouncer (port 6432) instead of PostgreSQL (port 5432):

```bash
psql -h localhost -p 6432 -U user mydb
```

Monitor PgBouncer:

```bash
# Connect to PgBouncer admin database
psql -p 6432 -U pgbouncer pgbouncer

# View pool stats
SHOW POOLS;
SHOW CLIENTS;
SHOW SERVERS;
```

Output:
```
database    | user    | cl_active | cl_waiting | sv_active | sv_idle | sv_used | sv_tested | sv_login
────────────────────────────────────────────────────────────────────────────────────────────────────────
mydb        | user    |         1 |          0 |         1 |      24 |       0 |         0 |        0
```

**Interpretation:**
- **cl_active**: Client connections actively using a server connection
- **cl_waiting**: Client connections waiting for a server connection
- **sv_active**: Server connections in use
- **sv_idle**: Server connections idle in pool
- **sv_used**: Connections used for more than once

### PgBouncer Limitations

- **Prepared statements** don't work across transactions (statement mode)
- **Session state** is per-backend; pooled connections lose it
- **Locks** held across transactions can deadlock

Solutions:
- Use `RESET` to clear session state
- Avoid `SET` commands outside transactions
- Use application-level connection pooling (for Java, use HikariCP; Python, use psycopg pool)

## Background Workers & Auxiliary Processes

PostgreSQL spawns special-purpose processes:

### Background Writers
Flushes dirty pages to disk in the background (during idle time):

```bash
ps aux | grep postgres | grep bgwriter
```

Configuration:

```sql
SHOW bgwriter_delay;              -- Every 200ms
SHOW bgwriter_lru_maxpages;       -- Flush up to 100 pages
SHOW bgwriter_lru_multiplier;     -- Flush more if other backends need it
```

### Autovacuum Launcher & Workers
Manages VACUUM/ANALYZE:

```bash
ps aux | grep postgres | grep autovacuum
```

Configuration:

```sql
SHOW autovacuum;                  -- Default: on
SHOW autovacuum_max_workers;      -- Default: 3 (parallel VACUUM workers)
SHOW autovacuum_naptime;          -- Check every 10s
```

### WAL Writer
Flushes WAL buffers to disk:

```bash
ps aux | grep postgres | grep "wal writer"
```

### Checkpointer
Manages checkpoints (Part 5):

```bash
ps aux | grep postgres | grep checkpointer
```

### Custom Background Workers

Write custom background workers in C:

```c
// bgworker.c
#include "postgres.h"
#include "postmaster/bgworker.h"

void _PG_init(void) {
    BackgroundWorker worker;
    worker.bgw_name = "my_worker";
    worker.bgw_type = "my_custom_worker";
    worker.bgw_main = main_worker;
    RegisterBackgroundWorker(&worker);
}

static void main_worker(Datum arg) {
    // Worker logic: polling, cleaning, aggregating, etc.
    while (!got_sigterm) {
        // Do work
        sleep(1);
    }
    proc_exit(0);
}
```

Register in `shared_preload_libraries`:

```sql
ALTER SYSTEM SET shared_preload_libraries = 'bgworker';
pg_ctl restart
```

## Viewing Active Processes

Check what's running:

```sql
SELECT
    pid,
    usename,
    application_name,
    state,
    query_start,
    state_change,
    wait_event_type,
    wait_event
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY query_start;
```

Key columns:
- **wait_event_type**: What is the backend waiting on? ('IO', 'Lock', 'CPU', NULL)
- **wait_event**: Specific event (e.g., 'IndexPageRead' if waiting for I/O)

Identify slow queries:

```sql
SELECT
    pid,
    usename,
    now() - query_start AS query_duration,
    state,
    query
FROM pg_stat_activity
WHERE state != 'idle'
ORDER BY query_start;
```

Kill a slow query:

```sql
SELECT pg_terminate_backend(12345);  -- PID 12345
```

## Practical Configuration

### For OLTP (Many Concurrent Connections)

```sql
ALTER SYSTEM SET max_connections = 500;
ALTER SYSTEM SET superuser_reserved_connections = 10;
ALTER SYSTEM SET idle_in_transaction_session_timeout = '5 min';

-- Use PgBouncer on the application tier
-- pgbouncer.ini:
-- max_client_conn = 10000
-- default_pool_size = 50
-- reserve_pool_size = 10
```

### For Data Warehouse (Few Connections, Long Queries)

```sql
ALTER SYSTEM SET max_connections = 50;
ALTER SYSTEM SET idle_in_transaction_session_timeout = 0;  -- Disable timeout
ALTER SYSTEM SET statement_timeout = 0;  -- Long queries OK

-- No connection pooling (overhead not needed)
```

## Key Takeaways

- **Postmaster** forks a backend process per connection. Simple but memory-intensive.
- **Each backend** allocates ~5–10 MB minimum, plus work_mem and temp_buffers.
- **Connection pooling** (PgBouncer, application-level) is critical for high-concurrency workloads.
- **Pool modes** trade simplicity for compatibility: statement mode is fastest but breaks some applications.
- **Resource limits** (statement_timeout, temp_file_limit, idle_in_transaction_session_timeout) prevent runaway queries.
- **Background workers** (autovacuum, bgwriter, WAL writer) manage housekeeping.
- **pg_stat_activity** shows active backends, wait events, and resource usage.

## Monitoring & Troubleshooting

Create a health check query:

```sql
SELECT
    'max_connections' AS metric,
    CONCAT(current_setting('max_connections'), ' (', COUNT(*), ' active)') AS value
FROM pg_stat_activity

UNION ALL

SELECT
    'idle_backends',
    COUNT(*)::text
FROM pg_stat_activity
WHERE state = 'idle'

UNION ALL

SELECT
    'long_running_queries',
    COUNT(*)::text || ' (> 60 sec)'
FROM pg_stat_activity
WHERE state != 'idle' AND now() - query_start > interval '60 sec';
```

## Conclusion: The Full Picture

You've now seen PostgreSQL from the ground up:

1. **Part 1 (Pages):** How data lives on disk — 8KB pages, tuples, alignment, TOAST
2. **Part 2 (MVCC):** How concurrent transactions see different versions of rows without locking
3. **Part 3 (Indexes):** How B-trees enable fast lookups and index-only scans
4. **Part 4 (Planning):** How the cost model estimates query costs and chooses execution strategies
5. **Part 5 (Memory):** How shared buffers cache pages, and how dirty pages are flushed via checkpoints
6. **Part 6 (WAL):** How write-ahead logging guarantees durability and enables replication
7. **Part 7 (Processes):** How connections are managed via forking, and why pooling is essential

These pieces fit together into a whole: A reliable, high-performance database that can scale to millions of transactions while surviving crashes and supporting real-time replication.

The next time a query is slow, you'll know exactly where to look. The next time you tune PostgreSQL, you'll understand the implications.

---

**Part 7 complete. You've finished the PostgreSQL Internals Series!**

For deeper dives, explore:
- PostgreSQL source code (src/backend/)
- Official documentation (www.postgresql.org/docs/18/)
- PEP talks from the PostgreSQL community conference
- Books: "PostgreSQL 15 Internals" by Egor Rogov, "The Art of PostgreSQL" by Dimitri Fontaine
