---
title: "Debezium Series, Part 7: Snapshotting"
description: "How Debezium captures existing data before streaming live changes. All snapshot modes explained — initial, never, always, when_needed — plus isolation guarantees and large-table strategies."
pubDate: 2026-03-02
author: "ifkarsyah"
domain: "Streaming"
stack: ["Debezium", "Kafka", "PostgreSQL"]
---

When you register a Debezium connector for the first time, the WAL only contains recent changes. Existing rows in your tables are not in the WAL — they were written long before Debezium started watching. To capture the current state of your tables, Debezium performs an **initial snapshot**.

Understanding how snapshots work, what isolation they provide, and when to avoid them is essential for operating Debezium in production.

## What Is a Snapshot?

A snapshot is a consistent read of the current state of the monitored tables, performed before streaming begins. Each row read during the snapshot is published as a Kafka event with `op: "r"` (read) and `source.snapshot: "true"`.

```json
{
  "payload": {
    "before": null,
    "after": { "id": 1, "customer": "alice", ... },
    "op": "r",
    "source": {
      "snapshot": "true",
      ...
    }
  }
}
```

After the snapshot completes, Debezium switches to streaming from the WAL position recorded at the start of the snapshot. This guarantees no changes are missed during the snapshot window.

## Snapshot Modes

### `initial` (Default)

Performs a snapshot when the connector starts for the first time (no existing offset). On subsequent restarts, the snapshot is skipped — streaming resumes from the saved offset.

```json
"snapshot.mode": "initial"
```

Use `initial` for most production setups. It bootstraps the sink with existing data once, then streams changes continuously.

### `never`

No snapshot is performed. Streaming starts from the current WAL tail.

```json
"snapshot.mode": "never"
```

Use `never` when:
- You have already loaded historical data by other means
- You only care about future changes (audit logs, event sourcing)
- Tables are too large for a practical snapshot

**Warning**: Without a snapshot, your Kafka topic only contains changes from the moment the connector starts. The sink will not reflect the current state of the database unless you pre-load it separately.

### `always`

Performs a snapshot every time the connector starts, including restarts.

```json
"snapshot.mode": "always"
```

Use `always` for development or testing environments where you want a clean slate on each run. In production, this is rarely correct — it re-publishes every existing row on every restart.

### `when_needed`

Performs a snapshot only when necessary: when the connector starts without an offset, or when the saved offset is no longer valid (e.g., the replication slot was dropped or the WAL was rotated past the saved position).

```json
"snapshot.mode": "when_needed"
```

This is a safe fallback for connectors that may be offline long enough for the WAL to rotate past the last-saved position.

### `initial_only`

Performs only the snapshot, then stops. No streaming phase.

```json
"snapshot.mode": "initial_only"
```

Useful for one-time data migration: snapshot existing data into Kafka, then set up a separate connector with `never` for ongoing streaming.

### `no_data` (PostgreSQL only)

Captures the schema and creates replication structures but reads no rows. Streaming starts from the current WAL position.

```json
"snapshot.mode": "no_data"
```

Use `no_data` when you have pre-loaded historical data and want Debezium to capture schema information without re-publishing existing rows.

## Snapshot Isolation

A snapshot must be consistent: all rows must reflect the database state at a single point in time, even if the snapshot takes hours to complete.

### PostgreSQL

Debezium uses a **repeatable read transaction** for the snapshot:

```
1. Open a repeatable read transaction
2. Record the current WAL LSN (the "start of streaming" position)
3. SELECT * FROM each monitored table (within the transaction)
4. Commit the transaction
5. Begin streaming from the recorded LSN
```

Because the transaction is repeatable read, concurrent writes during the snapshot are invisible. The snapshot sees a consistent point-in-time view. After the snapshot, streaming starts from the LSN recorded in step 2 — so no changes are missed.

### MySQL

MySQL uses a **FLUSH TABLES WITH READ LOCK** to acquire a consistent position:

```
1. FLUSH TABLES WITH READ LOCK
2. Record binlog position (file + offset, or GTID)
3. Start a transaction with REPEATABLE READ
4. UNLOCK TABLES
5. SELECT * FROM each monitored table
6. Commit the transaction
7. Begin streaming from the recorded binlog position
```

The lock is held only long enough to record the binlog position — typically milliseconds. The actual data read happens after the lock is released, using the snapshot transaction for consistency.

**Important**: On MySQL, the lock can block other writes briefly. For large production databases, schedule snapshots during low-traffic periods or use MySQL's `snapshot.locking.mode = none` if you accept slightly inconsistent snapshots.

## Snapshot Locking Modes (MySQL)

```json
"snapshot.locking.mode": "minimal"   // Lock briefly for position, then read without lock
"snapshot.locking.mode": "none"       // No lock — may miss concurrent changes; inconsistent
"snapshot.locking.mode": "extended"   // Lock for the entire snapshot duration — safe but disruptive
```

`minimal` is the default and appropriate for most cases. Use `none` only for read replicas where consistency requirements are relaxed.

## Handling Large Tables

Snapshots of large tables (hundreds of millions of rows) can take hours. Several strategies manage this:

### Table Filtering

Only snapshot the tables you need:

```json
"table.include.list": "public.orders,public.products"
```

Exclude large historical or archival tables that are not needed in the CDC stream.

### Incremental Snapshots (Debezium 1.6+)

Traditional snapshots lock position but read all rows serially, which can be slow and interruptive. **Incremental snapshots** chunk the table and interleave snapshot chunks with streaming:

```json
"snapshot.mode": "initial",
"incremental.snapshot.chunk.size": "1024"
```

Incremental snapshots use a **watermarking protocol**:
1. Emit a low watermark to the topic
2. Read a chunk of rows (e.g., 1024 rows by primary key range)
3. Emit a high watermark
4. Consumers deduplicate snapshot rows against streaming events using the watermarks

This allows the snapshot to proceed in the background without blocking streaming, and can be paused and resumed.

To trigger an incremental snapshot on a running connector:

```bash
# Via Kafka signal topic
echo '{"type":"execute-snapshot","data":{"data-collections":["public.orders"]}}' | \
  kafka-console-producer --bootstrap-server kafka:9092 --topic debezium-signals
```

Or via the Debezium REST API (Debezium 2.x):

```bash
curl -X POST http://localhost:8083/connectors/orders-connector/execute-snapshot \
  -H "Content-Type: application/json" \
  -d '{"data-collections": ["public.orders"]}'
```

### Snapshot Parallelism

For very wide or very large tables, configure multiple snapshot threads:

```json
"snapshot.max.threads": "4"
```

Each thread handles a disjoint range of rows. Requires a primary key for range splitting.

## Snapshot Events in Your Sink

Snapshot events have `op: "r"` and `source.snapshot: "true"` or `"last"` (the last event of the snapshot). Your sink must handle these:

- For Delta Lake / Iceberg: snapshot events should be treated as inserts (no `before`, only `after`)
- For JDBC sink: upsert semantics handle `r` events correctly — they insert if not present
- For audit logs: filter out `r` events if you only want live changes

```python
# In a Spark foreachBatch sink, treat snapshot reads as inserts
upserts = batch_df.filter(F.col("op").isin("c", "u", "r"))
```

## Key Takeaways

- Debezium snapshots capture existing data as `op: "r"` events before streaming begins
- `initial` (default): snapshot once on first start; `never`: skip snapshot; `always`: snapshot every start; `when_needed`: snapshot only when offset is invalid
- PostgreSQL snapshots use repeatable read transactions — no locking of normal traffic
- MySQL snapshots use a brief `FLUSH TABLES WITH READ LOCK` to capture binlog position
- Incremental snapshots interleave snapshot chunks with streaming — use them for large tables
- Snapshot events have `source.snapshot: "true"` — handle them in your sink the same as inserts

**Next:** [Transforms & Routing](/blog/debezium-series-8-transforms)
