---
title: "Kafka Series, Part 6: Kafka Streams"
description: "Stream processing natively inside Kafka — KStream vs KTable, stateful aggregations, joins, windowing, and state stores."
pubDate: 2024-05-19
author: "ifkarsyah"
tags: ["Kafka", "Data Engineering", "Streaming"]
image:
  src: ./kafka-series.png
  alt: "Apache Kafka Streams"
---

## Stream Processing Without a Separate Cluster

To process Kafka events with Flink or Spark Streaming, you need a separate compute cluster. **Kafka Streams** is different: it is a Java/Scala library that runs inside your application. There is no separate cluster to manage. Your application reads from Kafka, processes, and writes back to Kafka — all through the library.

This makes Kafka Streams the right choice when:
- You want stream processing without the operational overhead of a Flink or Spark cluster
- Your processing logic maps well to the Kafka-native primitives (KStream, KTable)
- You need exactly-once end-to-end within the Kafka ecosystem

## KStream vs KTable

Kafka Streams has two core abstractions:

**KStream** — a stream of independent, immutable events. Every record is an event to process.

**KTable** — a changelog stream. Each record represents the latest value for a key, overwriting any previous value. A KTable is like a database table that receives change events — it materializes the current state of each key.

```java
StreamsBuilder builder = new StreamsBuilder();

// KStream: every record is processed
KStream<String, String> events = builder.stream("user-events");

// KTable: each key's latest value is maintained
KTable<String, String> userProfiles = builder.table("user-profiles");
```

The relationship: if you compact a KStream by key (keeping only the latest value per key), you get a KTable. If you emit every update in a KTable as an event, you get a KStream.

## Stateless Transformations

```java
KStream<String, String> events = builder.stream("user-events");

// filter
KStream<String, String> clicks = events.filter(
    (key, value) -> value.contains("click")
);

// map: transform each record
KStream<String, Integer> lengths = events.mapValues(String::length);

// flatMap: one record → many records
KStream<String, String> words = events.flatMapValues(
    value -> Arrays.asList(value.split(" "))
);

// branch: split a stream into multiple streams
KStream<String, String>[] branches = events.branch(
    (k, v) -> v.startsWith("click"),
    (k, v) -> v.startsWith("purchase"),
    (k, v) -> true  // catch-all
);
```

## Stateful Aggregations

Aggregations require state — Kafka Streams manages state in **state stores** (RocksDB-backed by default).

```java
// Count events per user
KTable<String, Long> userEventCounts = events
    .groupByKey()
    .count(Materialized.as("user-event-count-store"));

// Write result to output topic
userEventCounts.toStream().to("user-event-counts");
```

For more complex aggregations:

```java
KTable<String, Long> revenueByUser = orders
    .groupBy((key, order) -> KeyValue.pair(order.getUserId(), order))
    .aggregate(
        () -> 0L,                                        // initializer
        (userId, order, total) -> total + order.getAmount(),  // aggregator
        Materialized.as("revenue-store")
    );
```

## Windowed Aggregations

```java
// Tumbling window: count events per user per 5-minute window
KTable<Windowed<String>, Long> windowedCounts = events
    .groupByKey()
    .windowedBy(TimeWindows.ofSizeWithNoGrace(Duration.ofMinutes(5)))
    .count(Materialized.as("windowed-count-store"));

// Sliding window: events in any 10-minute window, updated every 5 minutes
KTable<Windowed<String>, Long> slidingCounts = events
    .groupByKey()
    .windowedBy(SlidingWindows.ofTimeDifferenceWithNoGrace(Duration.ofMinutes(10)))
    .count();
```

Kafka Streams uses **event time** from the record timestamp. Late records are handled based on the grace period — records arriving after the grace period are dropped.

## Joins

Kafka Streams supports three join types:

**KStream-KTable join** (lookup): enrich a stream with the latest value from a table.

```java
KStream<String, Order> orders = builder.stream("orders");
KTable<String, User> users = builder.table("users");

KStream<String, EnrichedOrder> enriched = orders.join(
    users,
    (order, user) -> new EnrichedOrder(order, user),
    Joined.with(Serdes.String(), orderSerde, userSerde)
);
```

**KStream-KStream join** (windowed): join two streams where records arrive within a time window of each other.

```java
KStream<String, Click> clicks = builder.stream("clicks");
KStream<String, Purchase> purchases = builder.stream("purchases");

KStream<String, ClickWithPurchase> joined = clicks.join(
    purchases,
    (click, purchase) -> new ClickWithPurchase(click, purchase),
    JoinWindows.ofTimeDifferenceWithNoGrace(Duration.ofMinutes(10)),
    StreamJoined.with(Serdes.String(), clickSerde, purchaseSerde)
);
```

**KTable-KTable join**: join two tables on their keys — fires whenever either table updates.

## State Stores and Interactive Queries

State stores are RocksDB instances embedded in the Kafka Streams application. You can query them directly — without going through Kafka — for real-time lookups:

```java
// Get the state store
ReadOnlyKeyValueStore<String, Long> store = streams.store(
    StoreQueryParameters.fromNameAndType(
        "user-event-count-store",
        QueryableStoreTypes.keyValueStore()
    )
);

// Query
Long count = store.get("user-42");
```

This is called **Interactive Queries** — your Kafka Streams app doubles as a queryable microservice. State stores are backed by changelog topics in Kafka, so they survive application restarts.

## Exactly-Once Processing

Kafka Streams supports exactly-once end-to-end within Kafka:

```java
Properties props = new Properties();
props.put(StreamsConfig.APPLICATION_ID_CONFIG, "my-streams-app");
props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092");
props.put(StreamsConfig.PROCESSING_GUARANTEE_CONFIG, StreamsConfig.EXACTLY_ONCE_V2);
```

With `EXACTLY_ONCE_V2`, Kafka Streams uses transactions internally: reading from input topics, processing, and writing to output topics are all part of a single atomic transaction. If the application fails mid-processing, the transaction is aborted and the input offsets are not committed.

## Running a Kafka Streams App

```java
Properties props = new Properties();
props.put(StreamsConfig.APPLICATION_ID_CONFIG, "user-analytics");
props.put(StreamsConfig.BOOTSTRAP_SERVERS_CONFIG, "kafka:9092");
props.put(StreamsConfig.DEFAULT_KEY_SERDE_CLASS_CONFIG, Serdes.String().getClass());
props.put(StreamsConfig.DEFAULT_VALUE_SERDE_CLASS_CONFIG, Serdes.String().getClass());

StreamsBuilder builder = new StreamsBuilder();
// ... define topology ...

KafkaStreams streams = new KafkaStreams(builder.build(), props);

// Handle shutdown cleanly
Runtime.getRuntime().addShutdownHook(new Thread(streams::close));

streams.start();
```

Scale by running multiple instances with the same `application.id` — Kafka Streams automatically distributes partitions across instances, just like consumer groups.

## Kafka Streams vs Flink

| | Kafka Streams | Apache Flink |
|---|---|---|
| Deployment | Library — runs in your app | Separate cluster |
| Language | Java / Scala | Java, Scala, Python |
| Exactly-once | Within Kafka only | End-to-end (any sink) |
| Windowing | Event time, tumbling/sliding | Event time + advanced watermarks |
| State | RocksDB (local) | RocksDB or heap (distributed) |
| Best for | Kafka-native pipelines, microservices | Complex pipelines, cross-system exactly-once |

## Key Takeaways

- **KStream** is a stream of events; **KTable** is a changelog maintaining the latest value per key
- Kafka Streams manages **state stores** (RocksDB) co-located with processing — no external database needed
- **Joins**: KStream-KTable for enrichment, KStream-KStream for windowed event matching
- **Interactive Queries** let you query state stores directly from your application
- `EXACTLY_ONCE_V2` gives end-to-end exactly-once within the Kafka ecosystem using transactions
- Scale by running multiple instances with the same `application.id` — partitions are distributed automatically

---

That wraps the Kafka Series. You now have the foundation to build, operate, and scale Kafka-based data pipelines: from the fundamental data model of topics and offsets, through producing and consuming reliably, to ensuring durability, integrating external systems with Connect, and building stateful stream processing with Kafka Streams.
