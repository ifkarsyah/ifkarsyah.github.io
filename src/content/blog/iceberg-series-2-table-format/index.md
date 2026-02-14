---
title: "Iceberg Series, Part 2: Table Format Internals"
description: "The four-layer metadata hierarchy — table metadata, manifest lists, manifest files, and data files — and how it enables efficient scans and snapshot isolation."
pubDate: 2024-10-20
author: "ifkarsyah"
tags: ["Iceberg", "Data Engineering", "Data Lake"]
image:
  src: ./iceberg-series.png
  alt: "Apache Iceberg Table Format Internals"
---

## Why the Metadata Structure Matters

Delta Lake uses a flat sequence of JSON commit files. This is simple but has a scaling challenge: reconstructing the current table state requires replaying many log files (mitigated by checkpoints). For tables with millions of data files and years of history, even checkpointing can become a bottleneck.

Iceberg takes a different approach: a **hierarchical metadata structure** where each layer indexes the layer below it. A query that needs to find which data files contain rows matching `WHERE country = 'US'` can skip most manifest files without even opening them — all by reading just a few kilobytes of manifest-level statistics.

## The Four Layers

### Layer 1: Catalog

The catalog maps a table name (`prod.db.events`) to the URI of the table's current **metadata file**. This indirection is what enables atomic table swaps, renames, and cross-engine access.

```
Catalog entry:
  prod.db.events → s3://bucket/warehouse/db/events/metadata/v3.metadata.json
```

The catalog is covered in Part 3. For now, think of it as a pointer.

### Layer 2: Table Metadata File

The current metadata file (`metadata.json`) is the root of all table state. It contains:

- **Current snapshot ID** — which snapshot is "now"
- **Schema history** — all past and present schemas, each identified by an integer ID
- **Partition spec history** — all past and present partition specifications
- **Sort order history** — sort order used for data file layout
- **Snapshot log** — lightweight record of every snapshot ever created

```json
{
  "format-version": 2,
  "table-uuid": "d6a0e7f4-...",
  "location": "s3://bucket/warehouse/db/events",
  "current-snapshot-id": 3821550127947089757,
  "current-schema-id": 1,
  "current-partition-spec-id": 0,
  "schemas": [{"schema-id": 0, ...}, {"schema-id": 1, ...}],
  "snapshots": [
    {"snapshot-id": 3821550127947089757, "manifest-list": "s3://.../snap-3821.avro"}
  ]
}
```

Updating a table creates a **new** metadata file and atomically updates the catalog to point to it — a single atomic rename operation that the catalog performs.

### Layer 3: Manifest List (Snapshot)

Each snapshot has a **manifest list** — an Avro file that lists all manifest files belonging to that snapshot, along with summary statistics about each manifest:

```
snap-3821550127947089757.avro
├── manifest_path: s3://.../events/metadata/abc123.avro
│   partition_summaries: [{field: "country", lower: "DE", upper: "US"}]
│   added_rows_count: 50000
│   existing_rows_count: 200000
│
└── manifest_path: s3://.../events/metadata/def456.avro
    partition_summaries: [{field: "country", lower: "FR", upper: "FR"}]
    added_rows_count: 0
    existing_rows_count: 30000
```

**Partition pruning at the manifest list level**: a query `WHERE country = 'US'` can skip the entire second manifest (`FR` only) without even opening it. This is metadata-level pruning that scales to tables with thousands of manifest files.

### Layer 4: Manifest Files

Each manifest file (Avro) lists a subset of data files with per-file statistics:

```
abc123.avro
├── data_file: s3://.../events/data/part-00000.parquet
│   record_count: 131072
│   column_sizes: {user_id: 524288, country: 65536}
│   lower_bounds: {user_id: 1, event_at: 2024-01-01T00:00:00}
│   upper_bounds: {user_id: 9999, event_at: 2024-01-01T23:59:59}
│   null_value_counts: {amount: 80000}
│
└── data_file: s3://.../events/data/part-00001.parquet
    record_count: 98304
    lower_bounds: {user_id: 10000, event_at: 2024-01-01T08:00:00}
    upper_bounds: {user_id: 99999, event_at: 2024-01-01T23:59:59}
```

**Data file pruning at the manifest level**: a query `WHERE user_id = 42` reads the manifest, finds `part-00001.parquet` has `lower_bounds.user_id = 10000`, and skips it. Only `part-00000.parquet` is opened.

### Layer 5: Data Files

The actual Parquet (or ORC, Avro) files. Iceberg is storage-format-agnostic — Parquet is the default and most common.

## Scanning a Table: End to End

When you run `SELECT * FROM events WHERE country = 'US' AND user_id = 42`:

1. **Catalog** → returns the current metadata file URI
2. **Metadata file** → returns the current snapshot's manifest list URI
3. **Manifest list** → reads partition summaries; skips manifests with no `US` country entries
4. **Manifest files** (only the relevant ones) → reads file-level statistics; skips files where `upper_bounds.user_id < 42` or `lower_bounds.user_id > 42`
5. **Data files** (only surviving candidates) → reads and applies the filter

The result: a table with 1 billion rows and 10,000 data files may require reading only 3 files, after skipping at the manifest list and manifest file levels.

## Snapshot Isolation

Every write creates a new snapshot without modifying existing files. Readers always see a consistent snapshot:

```
Version 1 (snapshot A):
  manifest-list-A → [manifest-1, manifest-2]
    manifest-1 → [file-1.parquet, file-2.parquet]
    manifest-2 → [file-3.parquet]

Write appends file-4.parquet → creates Version 2 (snapshot B):
  manifest-list-B → [manifest-1, manifest-2, manifest-3]
    manifest-1 → [file-1.parquet, file-2.parquet]  ← shared with snapshot A
    manifest-2 → [file-3.parquet]                  ← shared with snapshot A
    manifest-3 → [file-4.parquet]                  ← new in snapshot B

Reader on snapshot A still sees only files 1, 2, 3.
Reader on snapshot B sees files 1, 2, 3, 4.
```

Manifests are **reused** across snapshots — a new append only adds a new manifest for the new files; existing manifests are referenced by pointer, not copied. This makes snapshots cheap to create and cheap to retain.

## Delete Files (Iceberg v2)

Iceberg v2 introduced **delete files** alongside data files. Instead of rewriting a data file to remove a row, Iceberg can write a small delete file that records which rows to exclude:

**Position delete files** — list specific file + row position pairs to delete:
```
delete.avro:
  (file-path: "part-00000.parquet", pos: 5)
  (file-path: "part-00000.parquet", pos: 12)
```

**Equality delete files** — list column values that identify deleted rows:
```
eq-delete.avro:
  user_id = 42
  user_id = 99
```

When reading, the engine applies delete files on top of data files. This is the **merge-on-read** approach — covered in detail in Part 5. The advantage: no data rewrite needed for deletes; the disadvantage: read-time overhead increases as delete files accumulate.

## Key Takeaways

- Iceberg's four layers: **catalog** → **metadata file** → **manifest list** → **manifest files** → **data files**
- **Partition pruning at the manifest list level** skips entire manifests based on partition summaries — before opening any data file
- **File-level statistics** (min/max, null counts) in manifest files enable data skipping at fine granularity
- Manifests are **shared across snapshots** — appends only add new manifests, making snapshots cheap
- **Delete files** (Iceberg v2) record row deletions without rewriting data files — the basis for merge-on-read

Next: Catalogs — how Hive, Glue, REST, and Nessie catalogs coordinate multi-engine access to the same Iceberg tables.
