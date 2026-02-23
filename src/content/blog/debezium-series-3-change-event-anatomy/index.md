---
title: "Debezium Series, Part 3: Change Event Anatomy"
description: "Dissecting every field in a Debezium change event — before, after, op, source metadata, tombstones, and how the Kafka message key is structured."
pubDate: 2026-02-26
author: "ifkarsyah"
domain: "Streaming"
stack: ["Debezium", "Kafka", "PostgreSQL"]
---

Every Debezium change event follows a well-defined structure. Understanding each field is essential for building consumers that correctly handle inserts, updates, deletes, and schema-level metadata. This part dissects a real event in full detail.

## The Kafka Message Structure

A Debezium event is a Kafka message with two parts:

- **Key**: identifies the changed row (primary key fields)
- **Value**: the change event itself (before/after states + metadata)

Both key and value have their own schemas. Understanding this distinction matters when configuring log compaction or keyed state in stream processors.

## The Message Key

```json
{
  "schema": {
    "type": "struct",
    "fields": [
      { "type": "int32", "field": "id" }
    ],
    "name": "shop.public.orders.Key"
  },
  "payload": {
    "id": 1
  }
}
```

The key contains only the primary key columns. For a table with a composite primary key, all columns appear here. The key is used by Kafka for:

- **Partitioning**: all events for a given row land on the same partition (ordering per row is preserved)
- **Log compaction**: keeps only the latest event per key, enabling efficient replays

## The Message Value

A full update event:

```json
{
  "schema": { ... },
  "payload": {
    "before": {
      "id": 1,
      "customer": "alice",
      "product": "laptop",
      "amount": 1299.00,
      "status": "pending",
      "created_at": "2026-02-25T10:00:00.000000Z"
    },
    "after": {
      "id": 1,
      "customer": "alice",
      "product": "laptop",
      "amount": 1299.00,
      "status": "shipped",
      "created_at": "2026-02-25T10:00:00.000000Z"
    },
    "source": {
      "version": "2.7.0.Final",
      "connector": "postgresql",
      "name": "shop",
      "ts_ms": 1740477600000,
      "snapshot": "false",
      "db": "shop",
      "sequence": "[\"23456700\",\"23456789\"]",
      "schema": "public",
      "table": "orders",
      "txId": 491,
      "lsn": 23456789,
      "xmin": null
    },
    "op": "u",
    "ts_ms": 1740477600123,
    "transaction": null
  }
}
```

## Field-by-Field Breakdown

### `before`

The row state **before** the change. For inserts, this is `null` — there was no prior state. For updates and deletes, this contains the old values.

```
op: "c" (insert)  →  before: null,     after: { new row }
op: "u" (update)  →  before: { old },  after: { new }
op: "d" (delete)  →  before: { old },  after: null
op: "r" (read)    →  before: null,     after: { row }  (snapshot)
```

`before` is only populated if `REPLICA IDENTITY FULL` is set on the table (PostgreSQL) or `binlog_row_image = FULL` (MySQL). Without it, `before` is null for updates and deletes.

### `after`

The row state **after** the change. For deletes, this is `null`.

### `op` — Operation Type

| Value | Meaning |
|-------|---------|
| `c`   | Create (INSERT) |
| `u`   | Update (UPDATE) |
| `d`   | Delete (DELETE) |
| `r`   | Read (snapshot row) |
| `t`   | Truncate (TABLE TRUNCATE) |

Your consumers should always branch on `op`. A naive consumer that only looks at `after` will silently miss deletes.

### `source` — Origin Metadata

The `source` block identifies exactly where and when the change happened.

| Field | Description |
|-------|-------------|
| `version` | Debezium connector version |
| `connector` | Connector type (`postgresql`, `mysql`, etc.) |
| `name` | Connector name / topic prefix |
| `ts_ms` | Timestamp when the change was committed in the database |
| `snapshot` | `"true"` if the event came from the initial snapshot, `"false"` for live changes |
| `db` | Database name |
| `schema` / `table` | Source table |
| `lsn` | PostgreSQL WAL position of this change |
| `txId` | PostgreSQL transaction ID |
| `sequence` | `[prev_lsn, current_lsn]` — useful for ordering within a transaction |

`source.ts_ms` is the **database commit time** — use this for event-time processing, not `ts_ms` at the top level (which is when Debezium processed the event).

### `ts_ms` (top-level)

When Debezium created this Kafka message. Useful for measuring CDC lag:

```
lag = top_level_ts_ms - source.ts_ms
```

If lag grows, Debezium is falling behind the WAL.

### `transaction`

When `provide.transaction.metadata = true` is configured, this field contains the transaction ID and event count — useful for grouping all changes from a single database transaction.

```json
"transaction": {
  "id": "491:23456789:0",
  "total_order": 3,
  "data_collection_order": 1
}
```

`total_order` is the position of this event within the transaction globally; `data_collection_order` is the position within changes to this specific table.

## The Schema Block

Each Kafka message includes a `schema` section describing the structure of the `payload`. This schema is inlined by default — every message carries its full schema definition.

```json
{
  "schema": {
    "type": "struct",
    "fields": [
      { "type": "struct", "fields": [...], "field": "before" },
      { "type": "struct", "fields": [...], "field": "after" },
      { "type": "struct", "fields": [...], "field": "source" },
      { "type": "string", "field": "op" },
      { "type": "int64",  "field": "ts_ms" }
    ],
    "name": "shop.public.orders.Envelope"
  }
}
```

Inlining schemas is verbose — each message repeats the full schema. In production, use **Confluent Schema Registry** with Avro serialization. The schema is registered once and messages carry only a schema ID:

```
4 bytes: magic byte (0x00) + schema ID  |  payload bytes
```

This reduces message size by 60–80% for wide tables.

## Tombstone Events

When a row is deleted, Debezium publishes two messages to Kafka:

**Message 1 — Delete event:**
```json
{
  "payload": {
    "before": { "id": 1, ... },
    "after": null,
    "op": "d"
  }
}
```

**Message 2 — Tombstone:**
```json
Key:   { "id": 1 }
Value: null
```

The tombstone is a Kafka convention for log-compacted topics. Kafka's log compaction retains the latest message per key. A null-value message signals that the key can be deleted during compaction. Without tombstones, deleted rows would persist in compacted topics indefinitely.

If your consumers do not use log compaction, tombstones are noise — filter them by checking `value == null`.

## Handling Data Types

Debezium maps database types to Kafka Connect logical types. Some require attention:

| PostgreSQL type | Kafka Connect type | Notes |
|---|---|---|
| `TIMESTAMPTZ` | `int64` (microseconds since epoch) | Not a string — convert before display |
| `DATE` | `int32` (days since epoch) | |
| `NUMERIC` / `DECIMAL` | `bytes` (base64 encoded) or `string` | Configure with `decimal.handling.mode` |
| `UUID` | `string` | |
| `JSONB` | `string` | Serialized as a JSON string |
| `ENUM` | `string` | |

The `decimal.handling.mode` setting is particularly important:

```json
"decimal.handling.mode": "string"  // "1299.00" — safe, human-readable
"decimal.handling.mode": "double"  // 1299.0   — loses precision for large decimals
"decimal.handling.mode": "precise" // base64 bytes — lossless but complex to decode
```

For financial data, always use `"string"` or `"precise"`.

## Key Takeaways

- Every Debezium event has a **key** (primary key) and a **value** (envelope with before/after/source/op)
- `op` determines the change type: `c`, `u`, `d`, `r`, `t`
- `source.ts_ms` is database commit time — use it for event-time processing
- `before` is null without `REPLICA IDENTITY FULL` (PostgreSQL) or `binlog_row_image = FULL` (MySQL)
- Tombstones are null-value messages that signal key deletion in log-compacted topics
- Use Schema Registry + Avro in production to avoid embedding schemas in every message

**Next:** [Source Connectors — PostgreSQL & MySQL](/blog/debezium-series-4-source-connectors)
