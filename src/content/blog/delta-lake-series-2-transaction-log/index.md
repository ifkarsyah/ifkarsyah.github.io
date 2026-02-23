---
title: "Delta Lake Series, Part 2: Transaction Log & ACID"
description: "How the Delta Lake transaction log enables atomicity, serializable isolation, optimistic concurrency, and conflict resolution."
pubDate: 2024-08-18
author: "ifkarsyah"
domain: "Data Lake"
stack: ["Delta Lake", "Spark"]
image:
  src: ./delta-lake-series.png
  alt: "Delta Lake Transaction Log and ACID"
---

## The Transaction Log Is the Table

In Delta Lake, the `_delta_log/` directory is not metadata about the table — it *is* the table. The Parquet files are just data blobs. The transaction log is the authoritative record of which files belong to the current version of the table, and what every past version looked like.

Understanding the log structure explains how all of Delta Lake's guarantees — atomicity, isolation, time travel, and schema enforcement — are implemented.

## Log Structure

Each committed transaction produces a numbered JSON file:

```
_delta_log/
├── 00000000000000000000.json   ← version 0
├── 00000000000000000001.json   ← version 1
├── 00000000000000000002.json   ← version 2
...
├── 00000000000000000010.checkpoint.parquet  ← checkpoint at version 10
├── 00000000000000000020.checkpoint.parquet  ← checkpoint at version 20
└── _last_checkpoint                          ← pointer to latest checkpoint
```

Every 10 commits (configurable), Delta Lake writes a **checkpoint** — a Parquet snapshot of the full table state at that version. On startup, the reader loads the latest checkpoint, then replays only the JSON files after it. Without checkpoints, replaying millions of JSON files would be slow.

## Actions in the Log

Each JSON commit file contains a list of **actions**:

**`add`** — a new Parquet file is part of the table:
```json
{
  "add": {
    "path": "part-00000-abc.snappy.parquet",
    "partitionValues": {"date": "2024-01-01"},
    "size": 102400,
    "modificationTime": 1704067200000,
    "dataChange": true,
    "stats": "{\"numRecords\": 8192, \"minValues\": {\"user_id\": 1}, \"maxValues\": {\"user_id\": 9999}}"
  }
}
```

**`remove`** — a Parquet file is no longer part of the table (logically deleted):
```json
{
  "remove": {
    "path": "part-00000-old.snappy.parquet",
    "deletionTimestamp": 1704067200000,
    "dataChange": true
  }
}
```

**`metaData`** — records schema, partition columns, and table configuration (present in version 0 and on schema changes):
```json
{
  "metaData": {
    "schemaString": "{\"type\":\"struct\",\"fields\":[...]}",
    "partitionColumns": ["date"],
    "configuration": {"delta.enableChangeDataFeed": "true"}
  }
}
```

**`commitInfo`** — human-readable operation metadata:
```json
{
  "commitInfo": {
    "timestamp": 1704067200000,
    "operation": "MERGE",
    "operationParameters": {"predicate": "[\"user_id = 42\"]"},
    "readVersion": 4,
    "isolationLevel": "Serializable"
  }
}
```

The current table state is the union of all `add` actions minus all `remove` actions, replayed in order from the last checkpoint.

## Atomicity

When a write job finishes, it attempts to **atomically commit** a single JSON file. If the file write succeeds, the transaction is committed. If the job crashes before writing the JSON file, the uploaded Parquet files exist on disk but are not referenced by any commit — they are invisible to readers and will be cleaned up by `VACUUM`.

This is atomic not because of any distributed lock, but because object storage (S3, GCS, ADLS) provides **atomic put-if-absent** semantics: writing a file only succeeds if no file with that name already exists. Delta Lake uses this to implement **optimistic concurrency control**.

## Optimistic Concurrency and Conflict Resolution

Delta Lake assumes that concurrent writers will not conflict most of the time. Instead of locking, writers proceed optimistically:

1. **Read** the current version (e.g., version 5)
2. **Compute** the changes (new files to add, old files to remove)
3. **Attempt to commit** by writing `00000000000000000006.json`
4. If another writer already wrote version 6, the commit fails → **retry with conflict resolution**

On conflict, Delta Lake checks whether the two concurrent transactions are compatible:

- **Compatible**: Writer A appended to partition `date=2024-01-01`; Writer B appended to `date=2024-01-02`. No overlap → Delta Lake accepts both, rebases Writer B's commit to version 7.
- **Incompatible**: Writer A updated rows matching `user_id = 42`; Writer B deleted those same rows. Overlap → `ConcurrentModificationException`.

```python
# Delta Lake raises this if two writers conflict on the same rows
org.apache.spark.sql.delta.exceptions.ConcurrentModificationException:
  Files were added to the target by a concurrent update.
  Please retry your operation.
```

This means Delta Lake scales well for parallel appends (common in partitioned pipelines) but serializes conflicting row-level updates.

## Isolation Levels

Delta Lake supports two isolation levels:

**Snapshot Isolation** (default for reads): a reader always sees the consistent state of the table at the version when the read started, regardless of concurrent writes.

**Serializable** (default for writes): write transactions are ordered as if they executed one at a time. A write that reads data (like `MERGE` or `UPDATE`) will fail if a concurrent write changed the data it read.

```python
# Configure isolation level per table
spark.sql("""
    ALTER TABLE events
    SET TBLPROPERTIES ('delta.isolationLevel' = 'Serializable')
""")
```

`WriteSerializable` is a weaker but higher-throughput option: it only checks for conflicts on the files actually written, not on all files read. Safe for append-only pipelines; use `Serializable` when correctness of read-modify-write operations matters.

## What Happens During a MERGE

A `MERGE` (upsert) illustrates the full transaction lifecycle:

1. **Scan**: read the source (updates) and find matching rows in the target
2. **Identify affected files**: which Parquet files in the target contain matching rows?
3. **Rewrite**: rewrite only the affected files with updated rows; generate new `add` and `remove` actions
4. **Commit**: write a single JSON file listing all `add` and `remove` actions
5. **Conflict check**: if another writer committed between step 1 and step 4, check compatibility and retry or fail

The key insight: a `MERGE` touching 1,000 rows in 5 files rewrites only those 5 files — not the entire table.

## Log Compaction and VACUUM

`remove` actions do not delete Parquet files from disk — they just mark them as no longer part of the current table. The physical files remain for time travel. **VACUUM** deletes them:

```python
delta_table = DeltaTable.forPath(spark, "s3://my-bucket/tables/events")

# Delete files removed more than 7 days ago (default retention)
delta_table.vacuum()

# Shorter retention (dangerous — breaks time travel)
delta_table.vacuum(retentionHours=24)
```

Never set retention below the longest running transaction in your cluster — a query reading version N needs all the files from version N to still exist.

## Key Takeaways

- The `_delta_log/` is the table: it records every `add` and `remove` action as numbered JSON files
- **Checkpoints** (every 10 commits) compact the log into a single Parquet snapshot for fast startup
- **Atomicity** comes from object storage's put-if-absent: a commit either succeeds or fails — no partial state
- **Optimistic concurrency** lets parallel writers proceed without locking; conflicts are detected at commit time
- **VACUUM** physically deletes removed files; keep retention ≥ 7 days to preserve time travel

Next: Schema Enforcement & Evolution — how Delta Lake validates schemas on write and handles controlled changes over time.
