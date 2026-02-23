---
title: "Debezium Series, Part 6: Handling Schema Changes"
description: "What happens when someone alters a table. DDL propagation, Schema Registry integration, breaking vs non-breaking changes, and strategies to evolve without downtime."
pubDate: 2026-03-01
author: "ifkarsyah"
domain: "Streaming"
stack: ["Debezium", "Kafka", "PostgreSQL"]
---

Schema changes are inevitable. Columns get added, renamed, or dropped as applications evolve. In a traditional batch pipeline, a schema change is a scheduled event — you update the ETL script and rerun. In a CDC pipeline, schema changes happen in the middle of a live stream and must be handled without dropping data or breaking consumers.

## What Happens on a Schema Change

When a table schema changes, Debezium detects it through the replication log and updates the Kafka message schema accordingly.

For PostgreSQL, the schema is embedded in each message (or registered in Schema Registry). When a column is added, subsequent events include the new column. For MySQL, the DDL statement is recorded in the schema history topic and replayed on connector restart.

The core problem: **consumers that were built against the old schema may break when they encounter new schema events**.

## Non-Breaking vs Breaking Changes

### Non-Breaking Changes (Safe)

These changes do not break existing consumers:

| Change | Impact |
|--------|--------|
| Add a nullable column with default | New field appears in `after`; old consumers ignore unknown fields |
| Add a new table | New topic created; existing consumers unaffected |
| Increase column length (e.g., VARCHAR(50) → VARCHAR(200)) | No change to event structure |
| Add an index | Not visible in events |

### Breaking Changes (Dangerous)

These changes can break existing consumers:

| Change | Impact |
|--------|--------|
| Drop a column | Field disappears from events; consumers expecting it fail |
| Rename a column | Old field gone, new field appears; consumers using old name break |
| Change column type (e.g., INT → TEXT) | Value type in event changes; consumers fail on deserialization |
| Add a NOT NULL column without a default | Insert events start carrying the new field as required |

## Schema Registry Integration

Without Schema Registry, every Debezium message embeds its full schema — which is verbose and makes schema evolution harder to coordinate. With Schema Registry, schemas are registered centrally and messages carry only a compact schema ID.

```
┌──────────┐   register schema   ┌─────────────────┐
│ Debezium │ ─────────────────► │ Schema Registry  │
│          │ ◄───── schema ID ── │                 │
└────┬─────┘                    └─────────────────┘
     │ Kafka message: [schema_id | payload]
     ▼
┌──────────┐   fetch schema by ID  ┌─────────────────┐
│ Consumer │ ─────────────────────► │ Schema Registry │
└──────────┘                        └─────────────────┘
```

### Configuring Debezium with Schema Registry

```json
{
  "key.converter": "io.confluent.connect.avro.AvroConverter",
  "key.converter.schema.registry.url": "http://schema-registry:8081",
  "value.converter": "io.confluent.connect.avro.AvroConverter",
  "value.converter.schema.registry.url": "http://schema-registry:8081"
}
```

With Avro serialization, messages are binary-compact and schemas are managed centrally.

### Compatibility Modes

Schema Registry enforces a **compatibility mode** per subject (topic). The mode determines which schema changes are allowed:

| Mode | Allowed changes |
|------|----------------|
| `BACKWARD` | Consumers with new schema can read old messages. Add fields with defaults; delete fields. |
| `FORWARD` | Consumers with old schema can read new messages. Add fields; old consumers ignore new fields. |
| `FULL` | Both backward and forward. Only add optional fields with defaults. |
| `NONE` | No compatibility check. Any change allowed. |

For CDC pipelines, `FORWARD` or `FULL` is recommended — new events should be readable by consumers that haven't been updated yet.

```bash
# Set compatibility for a subject
curl -X PUT http://schema-registry:8081/config/shop.public.orders-value \
  -H "Content-Type: application/json" \
  -d '{"compatibility": "FORWARD"}'
```

## Handling Specific Schema Changes

### Adding a Column

```sql
ALTER TABLE orders ADD COLUMN discount NUMERIC(5,2) DEFAULT 0;
```

Debezium detects the change on the next WAL read. Subsequent events include the `discount` field. The Schema Registry registers a new schema version.

Consumers using `FORWARD` compatibility can ignore the new field until they are updated. Consumers using strict schema validation will fail — update them before the DDL is applied, or use a lenient deserializer.

### Dropping a Column

```sql
ALTER TABLE orders DROP COLUMN internal_note;
```

After the DROP, events no longer contain `internal_note`. Any consumer that requires this field will break. The safe sequence:

1. Update all consumers to not require `internal_note`
2. Deploy consumers
3. Run the DDL
4. Verify no consumer errors
5. Remove `internal_note` from consumer code

### Renaming a Column

PostgreSQL does not propagate RENAME COLUMN through logical replication in a way that Debezium can detect atomically. The safest approach:

1. Add the new column (`customer_name`)
2. Copy data via a trigger or application logic
3. Update consumers to read `customer_name`
4. Drop the old column (`customer`)

This is a multi-step migration, not a single ALTER TABLE.

### Changing Column Type

Type changes are the most disruptive. An INT → BIGINT change is relatively safe (consumers expecting INT may overflow on very large values, but usually work). An INT → TEXT change is a hard break.

Approach:
1. Add a new column with the target type
2. Backfill via application or migration script
3. Switch application writes to the new column
4. Update consumers
5. Drop the old column

## MySQL Schema History Topic

MySQL records every DDL statement in the schema history topic. When Debezium restarts, it replays this history to reconstruct the schema at the current binlog position.

```json
"schema.history.internal.kafka.topic": "schema-changes.shop",
"schema.history.internal.kafka.bootstrap.servers": "kafka:9092"
```

**Critical**: this topic must never be deleted or compacted. Set `cleanup.policy=delete` with `retention.ms=-1` (infinite retention):

```bash
kafka-topics.sh --alter \
  --topic schema-changes.shop \
  --config retention.ms=-1 \
  --bootstrap-server kafka:9092
```

If the schema history topic is lost, the connector cannot reconstruct the schema and must be reset with a fresh snapshot.

## PostgreSQL and DDL

PostgreSQL's logical replication does not propagate DDL changes the same way MySQL does. Schema changes in PostgreSQL are detected by Debezium when the first event arrives after the DDL — because the WAL record includes the new row format.

This means:
- No separate schema history topic is needed for PostgreSQL
- Schema changes are picked up immediately on the next DML
- The schema embedded in events (or registered in Schema Registry) updates automatically

## Practical Strategy: Schema Change Runbook

For production systems, follow a structured runbook for every schema change:

```
1. Pre-change
   □ Check active consumers and their schema version tolerance
   □ Verify Schema Registry compatibility mode is FORWARD or FULL
   □ Test the DDL in staging with a running Debezium pipeline

2. Apply change
   □ Run DDL in database
   □ Verify Debezium connector status is still RUNNING
   □ Inspect new event schema in Schema Registry

3. Post-change
   □ Check consumer error rates in monitoring
   □ Update consumers to handle new schema
   □ Remove backward-compatibility code after all consumers are updated
```

## Key Takeaways

- Non-breaking changes (add nullable column, add table) are safe; breaking changes (drop, rename, type change) require coordination
- Schema Registry with `FORWARD` or `FULL` compatibility prevents breaking consumers during schema evolution
- For dropping or renaming columns: update consumers first, then apply the DDL
- MySQL requires a persistent schema history topic — never delete it
- PostgreSQL detects schema changes automatically from the WAL; no schema history topic needed
- Treat schema changes as a deployment: plan, stage, and roll back if needed

**Next:** [Snapshotting](/blog/debezium-series-7-snapshotting)
