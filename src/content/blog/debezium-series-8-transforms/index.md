---
title: "Debezium Series, Part 8: Transforms & Routing"
description: "Single Message Transforms (SMTs) for reshaping, filtering, and routing CDC events. Field extraction, topic routing, sensitive data masking, and when to reach for a stream processor."
pubDate: 2026-03-03
author: "ifkarsyah"
domain: "Streaming"
stack: ["Debezium", "Kafka", "PostgreSQL"]
---

By default, Debezium publishes every change event exactly as it reads it from the database log — full envelope, all fields, to a single topic per table. Single Message Transforms (SMTs) let you reshape, filter, and route events within the Kafka Connect pipeline, before events reach Kafka topics.

SMTs run inline in the connector, with no additional infrastructure.

## What Are SMTs?

SMTs are Kafka Connect's transformation layer. They process each message individually — no joins, no aggregations, no state. Think of them as a map function applied to every event.

```
Database change
      │
      ▼
Debezium Connector
      │
      ▼ SMT 1 (extract field)
      │ SMT 2 (mask sensitive data)
      │ SMT 3 (route to topic)
      ▼
Kafka Topic
```

SMTs are configured as a chain in the connector config:

```json
"transforms": "flatten,mask,route",
"transforms.flatten.type": "...",
"transforms.mask.type": "...",
"transforms.route.type": "..."
```

## Unwrapping the Debezium Envelope

The most common SMT for Debezium is **ExtractNewRecordState** — it unwraps the `payload.after` value so downstream consumers receive a flat row instead of a full Debezium envelope.

Without the SMT:
```json
{ "payload": { "before": {...}, "after": { "id": 1, "status": "shipped" }, "op": "u" } }
```

With `ExtractNewRecordState`:
```json
{ "id": 1, "status": "shipped" }
```

Configuration:

```json
"transforms": "unwrap",
"transforms.unwrap.type": "io.debezium.transforms.ExtractNewRecordState",
"transforms.unwrap.drop.tombstones": "false",
"transforms.unwrap.delete.handling.mode": "rewrite",
"transforms.unwrap.add.fields": "op,source.ts_ms"
```

**`delete.handling.mode`** controls what happens to delete events:

| Value | Behavior |
|-------|----------|
| `drop` | Delete events are discarded — downstream never sees them |
| `rewrite` | Delete events are emitted with a `__deleted: true` field added |
| `none` | Delete events pass through with `after: null` (default envelope behavior) |

For sinks that cannot handle null values (e.g., JDBC), use `rewrite`. For sinks that handle `__deleted` (e.g., custom consumers), `rewrite` is cleaner than `drop`.

**`add.fields`**: Promotes metadata from the envelope into the flattened record. Useful for preserving `op` or `source.ts_ms` after unwrapping.

```json
"transforms.unwrap.add.fields": "op:__op,source.ts_ms:__source_ts"
```

Result:
```json
{ "id": 1, "status": "shipped", "__op": "u", "__source_ts": 1740477600000 }
```

## Topic Routing

By default, Debezium publishes events to `{topic.prefix}.{schema}.{table}`. The **RegexRouter** SMT lets you rename topics based on a regex pattern.

### Rename Topics

```json
"transforms": "route",
"transforms.route.type": "org.apache.kafka.connect.transforms.ReplaceField$Value",
"transforms.route.type": "org.apache.kafka.connect.transforms.RegexRouter",
"transforms.route.regex": "shop\\.public\\.(.*)",
"transforms.route.replacement": "cdc.$1"
```

This routes `shop.public.orders` → `cdc.orders`.

### Route by Field Value

**TopicNameFromField** (Debezium 2.x) routes events to different topics based on a field value:

```json
"transforms": "route",
"transforms.route.type": "io.debezium.transforms.partitions.PartitionRouting",
"transforms.route.partition.payload.fields": "after.status"
```

Or use a script-based SMT for complex routing logic.

### Consolidate Multiple Tables

Route all order-related tables to a single topic:

```json
"transforms": "route",
"transforms.route.type": "org.apache.kafka.connect.transforms.RegexRouter",
"transforms.route.regex": "shop\\.public\\.(orders|order_items|order_history)",
"transforms.route.replacement": "shop.orders_all"
```

Useful for consumers that need a unified view across related tables.

## Field Filtering

### Keep Only Specific Fields

**ReplaceField** removes or retains specific fields:

```json
"transforms": "keep",
"transforms.keep.type": "org.apache.kafka.connect.transforms.ReplaceField$Value",
"transforms.keep.whitelist": "id,status,updated_at"
```

Only `id`, `status`, and `updated_at` appear in the output. All other columns are dropped.

### Drop Specific Fields

```json
"transforms": "drop",
"transforms.drop.type": "org.apache.kafka.connect.transforms.ReplaceField$Value",
"transforms.drop.blacklist": "internal_note,debug_field"
```

## Masking Sensitive Data

**MaskField** replaces sensitive field values with a fixed string or zeros, without removing the field.

```json
"transforms": "mask",
"transforms.mask.type": "org.apache.kafka.connect.transforms.MaskField$Value",
"transforms.mask.fields": "credit_card_number,ssn",
"transforms.mask.replacement": "****"
```

All events will have `"credit_card_number": "****"` instead of the real value.

For hashing (consistent pseudonymization):

```json
"transforms": "hash",
"transforms.hash.type": "io.debezium.transforms.ByLogicalTableRouter",
```

Or implement a custom SMT that applies SHA-256 to the field value — useful when you need referential integrity (the same input always produces the same masked output) without exposing real data.

## Filtering Events

**Filter** SMT discards events based on a condition. Only events where the condition is true are published to Kafka.

```json
"transforms": "filter",
"transforms.filter.type": "io.debezium.transforms.Filter",
"transforms.filter.language": "jsr223.groovy",
"transforms.filter.condition": "value.after?.status == 'shipped'"
```

This publishes only events where `status` becomes `shipped`. All other events are dropped.

**Warning**: Filtering at the connector level means filtered events are gone — they never enter Kafka. If requirements change, you cannot replay filtered events without re-reading the database. Prefer filtering in consumers when in doubt.

Supported scripting languages: Groovy, JavaScript (Nashorn), or use the built-in expression language.

## Content-Based Routing (Debezium)

**ByLogicalTableRouter** maps multiple tables to a single logical topic, adding a routing field to distinguish the source:

```json
"transforms": "router",
"transforms.router.type": "io.debezium.transforms.ByLogicalTableRouter",
"transforms.router.topic.regex": "shop\\.public\\.(orders|products)",
"transforms.router.topic.replacement": "shop.catalog",
"transforms.router.key.enforce.uniqueness": "true",
"transforms.router.key.field.name": "__source_table"
```

Events from both `orders` and `products` land in `shop.catalog`, with `__source_table` identifying the origin. The key is made unique by prefixing it with the table name, preventing key collisions between tables.

## Timestamp Routing (Partitioning)

For time-series workloads, route events to different topics or partitions based on event time:

```json
"transforms": "tsroute",
"transforms.tsroute.type": "org.apache.kafka.connect.transforms.TimestampRouter",
"transforms.tsroute.topic.format": "${topic}-${timestamp}",
"transforms.tsroute.timestamp.format": "yyyy-MM"
```

This creates monthly topics: `shop.public.orders-2026-02`, `shop.public.orders-2026-03`. Useful for time-partitioned sinks or retention policies.

## When SMTs Are Not Enough

SMTs are stateless, single-message operations. They cannot:

- **Join** events across tables (e.g., enrich an order event with customer data)
- **Aggregate** events (e.g., count events per user per hour)
- **Re-order** events or apply windowing
- **Deduplicate** across messages

For these use cases, consume from Kafka and use a stream processor:

| Use case | Recommended tool |
|----------|-----------------|
| Stateless enrichment | SMT |
| Lookup join (static) | SMT with custom transform |
| Stream-stream join | Kafka Streams, Flink |
| Aggregation / windowing | Kafka Streams, Flink |
| Deduplication | Flink stateful operator |
| Complex routing with state | Flink |

A common pattern: use SMTs to unwrap and clean events, then use Flink or Kafka Streams for business-level transformations before landing in the sink.

## Key Takeaways

- SMTs run inline in the connector — no extra infrastructure, stateless, single-message only
- `ExtractNewRecordState` unwraps the Debezium envelope into a flat row — essential for most sinks
- `RegexRouter` and `ByLogicalTableRouter` handle topic naming and consolidation
- `MaskField` removes sensitive data before events reach Kafka — compliance-friendly
- `Filter` drops events at the source — powerful but irreversible; prefer consumer-side filtering for flexibility
- For stateful operations (joins, aggregations, deduplication), reach for Flink or Kafka Streams

**Next:** [Production Concerns](/blog/debezium-series-9-production)
