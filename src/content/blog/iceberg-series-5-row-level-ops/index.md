---
title: "Iceberg Series, Part 5: Row-Level Operations"
description: "How MERGE, UPDATE, and DELETE work in Iceberg — copy-on-write vs merge-on-read, when to use each, and the performance trade-offs."
pubDate: 2024-11-10
author: "ifkarsyah"
domain: "Data Lake"
stack: ["Apache Iceberg"]
image:
  src: ./iceberg-series.png
  alt: "Apache Iceberg Row-Level Operations"
---

## Row-Level Changes on Immutable Files

Parquet files are immutable — you cannot edit a row in place. To change a row, you must rewrite the file containing it. This is the fundamental challenge for any system that needs to support UPDATE, DELETE, or MERGE on a columnar file format.

Iceberg v2 supports two strategies for handling row-level changes, and you can choose per-table or even switch between them:

- **Copy-on-Write (COW)**: rewrite data files at write time; fast reads, slower writes
- **Merge-on-Read (MOR)**: write small delete files at write time, apply them at read time; fast writes, slower reads

## Copy-on-Write (COW)

The default mode. When a row is updated or deleted, Iceberg rewrites the entire data file containing that row — emitting a new data file without the deleted row, or with the updated value:

```
Before DELETE WHERE user_id = 42:
  part-00000.parquet: [row 0: user 1] [row 1: user 42] [row 2: user 99]

After DELETE (COW):
  part-00000-new.parquet: [row 0: user 1] [row 2: user 99]  ← rewritten
  part-00000.parquet: marked as removed in the new snapshot
```

The new snapshot's manifest points to `part-00000-new.parquet` and removes `part-00000.parquet`. Readers on the new snapshot see no trace of user 42.

**Configure COW per operation type:**

```sql
ALTER TABLE local.db.events SET TBLPROPERTIES (
    'write.delete.mode'    = 'copy-on-write',
    'write.update.mode'    = 'copy-on-write',
    'write.merge.mode'     = 'copy-on-write'
);
```

**When to use COW:**
- Read-heavy tables where query speed is critical
- Low-frequency updates (e.g., end-of-day batch corrections)
- Tables served to BI tools / dashboards (no read overhead)

**COW cost:** write amplification. Updating 100 rows in a 1 GB file rewrites the full 1 GB. For tables with frequent small updates, this becomes expensive.

## Merge-on-Read (MOR)

Instead of rewriting data files, Iceberg writes small **delete files** that record which rows are deleted. At read time, the engine applies the delete files on top of the data files:

```
Before DELETE WHERE user_id = 42:
  part-00000.parquet: [row 0: user 1] [row 1: user 42] [row 2: user 99]

After DELETE (MOR):
  part-00000.parquet: unchanged            ← original file kept
  pos-delete-001.avro: (part-00000.parquet, row 1)  ← delete file

Read result: [row 0: user 1] [row 2: user 99]  ← merged at read time
```

**Configure MOR:**

```sql
ALTER TABLE local.db.events SET TBLPROPERTIES (
    'write.delete.mode'    = 'merge-on-read',
    'write.update.mode'    = 'merge-on-read',
    'write.merge.mode'     = 'merge-on-read'
);
```

**When to use MOR:**
- Write-heavy tables with frequent small updates (e.g., CDC from a database)
- Tables where write latency is critical (e.g., near-real-time ingestion)
- Pipelines that will run periodic compaction to clean up delete files

**MOR cost:** read amplification. As delete files accumulate, each read must merge more delete files. Run `rewriteDataFiles` periodically to compact delete files back into data files (covered in Part 6).

## DELETE

```sql
-- SQL DELETE
DELETE FROM local.db.events WHERE user_id = 42;
DELETE FROM local.db.events WHERE event_at < '2023-01-01';
```

In Python:

```python
from pyiceberg.catalog import load_catalog

catalog = load_catalog("prod", **{"type": "rest", "uri": "http://catalog:8181"})
table = catalog.load_table("db.events")

# Using Spark SQL
spark.sql("DELETE FROM local.db.events WHERE user_id = 42")
```

Row-scope DELETE scans the table for matching rows and either rewrites files (COW) or writes position delete files (MOR). Partition-scope DELETE (where the predicate aligns with the partition key) is much cheaper — entire data files are marked removed without reading their contents:

```sql
-- Efficient: removes entire partition data files without scanning rows
DELETE FROM local.db.events WHERE days(event_at) = DATE '2023-01-01';
```

## UPDATE

```sql
-- Update specific rows
UPDATE local.db.events
SET country = 'GB'
WHERE country = 'UK';

-- Update with subquery
UPDATE local.db.events
SET amount = amount * 1.1
WHERE user_id IN (SELECT user_id FROM premium_users);
```

In COW mode, UPDATE rewrites every affected data file. In MOR mode, it writes a delete file for the old row plus a new data file (or equality delete) for the new value — internally an UPDATE becomes a DELETE + INSERT at the file level.

## MERGE (Upsert)

`MERGE` is the most powerful row-level operation — it combines INSERT, UPDATE, and DELETE in a single atomic operation:

```sql
MERGE INTO local.db.events AS t
USING staging_events AS s
ON t.user_id = s.user_id AND t.event_at = s.event_at
WHEN MATCHED AND s.op = 'update' THEN
    UPDATE SET t.amount = s.amount, t.country = s.country
WHEN MATCHED AND s.op = 'delete' THEN
    DELETE
WHEN NOT MATCHED AND s.op != 'delete' THEN
    INSERT (event_at, user_id, event_type, country, amount)
    VALUES (s.event_at, s.user_id, s.event_type, s.country, s.amount);
```

This pattern is the foundation for **CDC ingestion pipelines**: incoming change events from Debezium or another CDC system are staged and then merged into the Iceberg table atomically.

### MERGE Performance Tips

**Filter the source aggressively**: the smaller the source table, the fewer files the engine needs to scan in the target.

**Use partition-aligned predicates**: if your MERGE condition includes a partition column, the engine can limit the scan to relevant partitions.

```sql
-- With days(event_at) partitioning, this MERGE only touches today's partition
MERGE INTO events t USING today_updates s
ON t.user_id = s.user_id
   AND t.event_at >= CURRENT_DATE       -- ← partition pruning hint
   AND t.event_at < CURRENT_DATE + 1;
```

**Prefer MOR for high-frequency MERGEs**: COW MERGE rewrites affected files on every run. For tables updated many times per hour, MOR is dramatically cheaper at write time.

## Comparing COW and MOR

| | Copy-on-Write | Merge-on-Read |
|---|---|---|
| Write cost | High (file rewrite) | Low (small delete file) |
| Read cost | Low (clean files) | Higher (merge at read time) |
| Best for | Batch corrections, low-frequency updates | CDC, streaming upserts, high-frequency changes |
| Compaction needed | No (files always clean) | Yes (delete files accumulate) |
| Query engine support | All engines | Requires MOR-capable engine |

## Choosing a Mode

A common pattern is to use **mixed modes**:

```sql
ALTER TABLE events SET TBLPROPERTIES (
    'write.delete.mode' = 'merge-on-read',   -- fast deletes
    'write.update.mode' = 'merge-on-read',   -- fast updates
    'write.merge.mode'  = 'copy-on-write'    -- COW for MERGE (often run in batch)
);
```

This gives fast individual DELETE/UPDATE (MOR) while keeping MERGE reads clean (COW). Schedule a nightly `rewriteDataFiles` to compact accumulated delete files.

## Key Takeaways

- **Copy-on-write** rewrites data files at write time — clean reads, expensive writes
- **Merge-on-read** writes small delete files — cheap writes, reads apply deletes on the fly
- Use COW for low-frequency batch updates; MOR for high-frequency CDC or streaming upserts
- **Partition-aligned DELETE** is cheapest — entire files are marked removed without row scanning
- **MERGE** is fully supported; use partition predicates to limit scan scope and improve performance
- MOR tables need periodic `rewriteDataFiles` compaction — covered in Part 6

**Next:** [Multi-Engine Analytics](/blog/iceberg-series-6)
