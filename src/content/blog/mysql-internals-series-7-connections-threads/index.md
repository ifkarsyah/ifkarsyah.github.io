---
title: "MySQL Internals Series, Part 7: Connection Management & Thread Model"
description: "How MySQL handles concurrent connections — thread pool, connection limits, resource management, and why connection pooling is essential."
pubDate: 2026-04-13
author: "ifkarsyah"
domain: "Backend"
stack: ["MySQL"]
image:
  src: ./mysql-series.png
  alt: "MySQL Connection Management"
---

MySQL is a **multi-threaded server**. Every connection gets its own thread. Understanding connection handling, the thread pool, resource limits, and why you need connection pooling separates optimized deployments from struggling ones.

This is the final part of the MySQL Internals series. We'll explore how MySQL scales from 1 to 10,000 concurrent connections, what breaks first, and how to architect for high concurrency.

## Connection Lifecycle

When a client connects to MySQL:

```
1. Client: TCP SYN to MySQL (port 3306)
2. MySQL: Accept connection, start a new thread
3. MySQL: Send handshake packet (version, auth plugin)
4. Client: Send credentials
5. MySQL: Authenticate user, check permissions
6. MySQL: Connection established, wait for queries
7. MySQL: Execute queries in the thread
8. Client: CLOSE or idle timeout
9. MySQL: Clean up thread, close socket
```

Each connection consumes:
- **Thread stack** — default 256 KB per thread on Linux
- **Connection buffer** — 192 KB for per-connection caches
- **Memory for prepared statements, temp tables, etc.**

Total per connection: **~1 MB minimum**.

## Thread Pool Architecture

MySQL can handle connections in two ways:

### 1. One-Thread-Per-Connection (traditional)

```
┌─────────────────────────────────┐
│ MySQL Server                    │
├─────────────────────────────────┤
│ Thread 1 ← Connection 1 (client A)
│ Thread 2 ← Connection 2 (client B)
│ Thread 3 ← Connection 3 (client C)
│ ...
│ Thread N ← Connection N
└─────────────────────────────────┘
```

**Pros:**
- Simple, stateless (each connection is independent)
- Good for persistent connections (e.g., application servers with pooling)

**Cons:**
- Many idle threads waste memory
- Thread creation is expensive (1-2 ms per new connection)
- OS struggles with >1000 threads

### 2. Thread Pool (MySQL 5.6+, Enterprise only in older versions)

```
┌─────────────────────────────────┐
│ MySQL Server (InnoDB)           │
├─────────────────────────────────┤
│ Thread Pool (e.g., 128 threads) │
│ ├─ Worker 1
│ ├─ Worker 2
│ └─ Worker N
├─────────────────────────────────┤
│ Connection Queue                │
│ ├─ Connection 1 (waiting)
│ ├─ Connection 2 (queued)
│ └─ ...
│ └─ Connection 10000 (queued)
└─────────────────────────────────┘
```

Connections are queued, and a pool of workers process them. Much more efficient for many short-lived connections (e.g., web requests).

**Configuration:**

```ini
[mysqld]
thread_stack = 262144              -- 256 KB per thread
thread_cache_size = 100            -- Keep 100 idle threads
innodb_thread_concurrency = 0      -- 0 = unlimited
max_connections = 1000             -- Maximum concurrent connections
```

On MySQL 8.0+, the thread pool is built-in (not Enterprise-only), but limited:

```sql
-- Check thread pool
SELECT @@thread_stack;
SELECT @@thread_cache_size;
```

## Connection Limits and Resource Exhaustion

### max_connections

The hard limit on concurrent connections:

```sql
SET GLOBAL max_connections = 5000;

SHOW STATUS LIKE 'Threads%';
-- Threads_connected: Number of active connections
-- Threads_created: Total threads created since startup
-- Threads_running: Queries currently executing
```

When `Threads_connected >= max_connections`, new connections are rejected.

**Problem:** If max_connections is 100 and you have 50 idle connections, only 50 new requests can connect.

### per_thread_memory

Each thread allocates:

```
Total Memory = (thread_stack + connection_buffer) * Threads_connected
             + shared buffers (buffer pool, query cache)
```

Example: 1000 connections × 1 MB = 1 GB just for threads. Then add buffer pool.

**Risk:** Too many connections exhaust RAM, OS starts swapping, and everything slows down.

## Resource Limits

### 1. Connection Limits

```sql
-- Per-user connection limits
CREATE USER 'app'@'localhost' IDENTIFIED BY 'password';
ALTER USER 'app'@'localhost' WITH MAX_CONNECTIONS_PER_HOUR 1000;  -- hourly limit
ALTER USER 'app'@'localhost' WITH MAX_USER_CONNECTIONS 100;       -- concurrent limit

-- Server-wide limit
SET GLOBAL max_connections = 5000;
```

### 2. Query Resource Limits

```sql
-- Timeout for queries (MySQL 5.7.7+)
SET SESSION max_statement_time = 10000;  -- 10 seconds, then kill

-- Limit rows examined (MySQL 5.7.7+)
SET SESSION max_join_size = 1000000;     -- Queries examine >1M rows are killed

-- Limit temp table size
SET SESSION tmp_table_size = 268435456;  -- 256 MB
```

### 3. Memory Limits

```sql
-- Per-query temp table memory
SET SESSION tmp_table_size = 268435456;      -- 256 MB
SET SESSION max_heap_table_size = 16777216;  -- 16 MB

-- Per-connection buffer limits
SET SESSION sort_buffer_size = 262144;       -- 256 KB (for ORDER BY)
SET SESSION read_rnd_buffer_size = 262144;   -- 256 KB (for range reads)
```

## Connection Pooling (Essential)

**Problem:** Creating and destroying threads is expensive. Web applications (thousands of requests/sec) can't handle direct MySQL connections.

**Solution:** Connection pooling — maintain a pool of persistent MySQL connections reused across requests.

```
Web Requests
    │
    ├─ Request 1 ─→ Pool (pick idle connection) ─→ MySQL
    ├─ Request 2 ─→ Pool (queue if no idle)    ─→ MySQL (wait)
    ├─ Request 3 ─→ Pool (queue if no idle)    ─→ MySQL (wait)
    └─ Request N ─→ Pool (queue if no idle)    ─→ MySQL
```

### Popular Pooling Solutions

**1. PgBouncer** (not MySQL-specific, but works)
```bash
# PgBouncer can pool MySQL via its generic connection proxy features
```

**2. ProxySQL**
```ini
# ProxySQL config
admin_variables =
{
    admin_credentials = "admin:admin"
}

mysql_variables =
{
    monitor_username = "monitor"
}

mysql_servers =
(
    { hostgroup_id=0, hostname="master.local", port=3306, weight=1000 },
    { hostgroup_id=1, hostname="replica.local", port=3306, weight=1000 }
)

mysql_query_rules =
(
    { match_pattern="^SELECT", destination_hostgroup=1, apply=1 },
    { match_pattern="^INSERT|UPDATE|DELETE", destination_hostgroup=0, apply=1 }
)
```

**3. Percona XtraDB Cluster** (with automatic read/write splitting)

**4. Application-Level Pooling** (recommended for most apps)

In your application (e.g., Node.js):

```javascript
const mysql = require('mysql2');

const pool = mysql.createPool({
  host: 'localhost',
  user: 'app',
  password: 'password',
  database: 'myapp',
  waitForConnections: true,
  connectionLimit: 10,        // Pool size
  queueLimit: 0               // Unlimited queue
});

// Reuse connections from pool
pool.query('SELECT * FROM users', (err, results) => {
  // Connection is returned to pool after query
});
```

**Key settings:**
- **connectionLimit** — pool size (typical: 10-50)
- **waitForConnections** — queue requests if pool full
- **enableKeepAlive** — TCP keep-alive to detect dead connections

## Monitoring Connections

```sql
-- Current connection status
SHOW STATUS LIKE 'Threads%';
SHOW STATUS LIKE 'Connections';

-- Show all connections
SHOW PROCESSLIST;
-- Columns: Id, User, Host, Db, Command, Time, State, Info

-- Detailed process info
SELECT * FROM INFORMATION_SCHEMA.PROCESSLIST
WHERE COMMAND != 'Sleep'
ORDER BY TIME DESC;

-- Kill a connection (dangerous!)
KILL <thread_id>;
KILL QUERY <thread_id>;  -- Safer: just cancel the query
```

### Metrics to Monitor

```sql
-- Connections per second
SELECT
  VARIABLE_VALUE / (
    SELECT VARIABLE_VALUE FROM PERFORMANCE_SCHEMA.GLOBAL_STATUS
    WHERE VARIABLE_NAME = 'Uptime'
  ) as connections_per_second
FROM PERFORMANCE_SCHEMA.GLOBAL_STATUS
WHERE VARIABLE_NAME = 'Connections';

-- Idle connections (should be pooled, not direct)
SELECT COUNT(*) FROM INFORMATION_SCHEMA.PROCESSLIST
WHERE COMMAND = 'Sleep' AND TIME > 60;

-- Long-running queries
SELECT * FROM INFORMATION_SCHEMA.PROCESSLIST
WHERE TIME > 300 AND COMMAND != 'Sleep';
```

## Best Practices for Connection Management

### 1. Use Connection Pooling

Direct connections are too expensive. Always pool.

```
Bad:  Web App → MySQL (create/destroy per request)
Good: Web App → Connection Pool → MySQL (reuse connections)
```

### 2. Set Reasonable Limits

```ini
[mysqld]
max_connections = 1000              -- Start small, scale up with hardware
thread_cache_size = 100             -- Keep idle threads for reuse
max_allowed_packet = 67108864       -- 64 MB for large queries
```

### 3. Monitor and Alert

```sql
-- Alert if connections approach max
SELECT @@max_connections,
       (SELECT COUNT(*) FROM INFORMATION_SCHEMA.PROCESSLIST) as active;
-- If active > max_connections * 0.8, scale up
```

### 4. Use Timeouts

```sql
-- Kill idle connections after 15 min
SET GLOBAL interactive_timeout = 900;
SET GLOBAL wait_timeout = 900;

-- Kill long-running queries
SET SESSION max_statement_time = 60000;  -- 60 seconds
```

### 5. Separate Read and Write Connections

If using read replicas, pool connections to master (writes) and replicas (reads) separately.

```
Writes → Connection Pool → Master
Reads  → Connection Pool → Replica 1
       → Connection Pool → Replica 2
```

## Example: Scaling from 100 to 10,000 Concurrent Connections

**Stage 1: Small (100 connections)**
```ini
max_connections = 200
innodb_buffer_pool_size = 4 GB
thread_stack = 262144
```

**Stage 2: Growing (1000 connections)**
```ini
max_connections = 1000
innodb_buffer_pool_size = 20 GB
thread_cache_size = 200
max_allowed_packet = 67108864
# Add read replicas for load distribution
```

**Stage 3: Large (10,000 connections)**
```ini
max_connections = 10000
innodb_buffer_pool_size = 100 GB
thread_cache_size = 500
# Use connection pooling (ProxySQL) for:
# - Connection multiplexing (pool size < 100, server max_connections = 1000)
# - Read/write splitting
# - Query caching
```

## Key Takeaways

1. **Every connection is a thread** — memory and OS resource overhead is real
2. **Connection pooling is mandatory** — reuse connections, don't create/destroy
3. **max_connections must match your architecture** — pool size + app servers
4. **Monitor idle connections** — long-lived idle connections waste resources
5. **Use timeouts** — kill idle and runaway queries
6. **Separate read and write paths** — scale replicas independently
7. **Thread pool is helpful but limited** — pooling at app level is more effective

## Conclusion

You've now explored the entire MySQL stack:

- **Part 1**: InnoDB storage and B-trees (data structure)
- **Part 2**: MVCC and transactions (concurrency)
- **Part 3**: Indexes (performance)
- **Part 4**: Query optimization (cost model)
- **Part 5**: Buffer pool (memory)
- **Part 6**: Binary logging and replication (durability and scaling)
- **Part 7**: Connections and threads (concurrency management)

With this knowledge, you can:
- Design schemas that leverage InnoDB's strengths
- Create indexes that the optimizer actually uses
- Tune buffer pool and memory for your workload
- Set up safe, scalable replication
- Handle thousands of concurrent connections
- Debug mysterious performance issues

The next step is **practice** — build something, measure it, and tune it. 🚀

---

**Part 7 complete. MySQL Internals Series finished!**
