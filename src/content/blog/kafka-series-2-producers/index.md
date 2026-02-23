---
title: "Kafka Series, Part 2: Producers"
description: "Writing to Kafka reliably — the producer API, batching, compression, delivery guarantees, and idempotent producers."
pubDate: 2024-04-21
author: "ifkarsyah"
domain: "Streaming"
stack: ["Kafka"]
image:
  src: ./kafka-series.png
  alt: "Apache Kafka Producers"
---

## The Producer's Job

A Kafka producer takes records from your application and delivers them to the right partition on the right broker. What looks like a simple `send()` call involves batching, serialization, partition assignment, retries, and acknowledgment — all configurable.

Understanding the producer means understanding where things can go wrong and what trade-offs you are making between throughput, latency, and durability.

## Basic Producer Setup

```python
from kafka import KafkaProducer
import json

producer = KafkaProducer(
    bootstrap_servers="kafka:9092",
    key_serializer=str.encode,
    value_serializer=lambda v: json.dumps(v).encode("utf-8"),
)

# Send with a key (deterministic partition assignment)
producer.send(
    "user-events",
    key="user-42",
    value={"event": "clicked", "item_id": "abc"},
)

producer.flush()  # wait for all pending sends to complete
```

`bootstrap_servers` is just the initial contact point — the producer will discover the full cluster topology automatically.

## The Send Pipeline

When you call `producer.send()`, the record does not go directly to the broker. It enters an internal pipeline:

1. **Serialize** key and value using the configured serializers
2. **Partition**: assign to a partition (hash of key, or round-robin if no key)
3. **Batch**: hold the record in an in-memory buffer (`RecordAccumulator`)
4. **Send**: a background I/O thread drains the buffer and sends batches to the broker
5. **Acknowledge**: the broker confirms receipt; the producer resolves the `Future`

This pipeline is why Kafka producers are highly efficient — they amortize the cost of network round-trips across many records.

## Batching and Throughput

Two settings control batching behavior:

```python
producer = KafkaProducer(
    bootstrap_servers="kafka:9092",
    batch_size=65536,       # max bytes per batch (default: 16384 = 16 KB)
    linger_ms=10,           # wait up to 10ms for the batch to fill before sending
)
```

- `batch_size`: the maximum bytes in a single batch to one partition. Larger batches = better throughput.
- `linger_ms`: how long the producer waits for more records before flushing an incomplete batch. `0` means send immediately (lowest latency). `5–50ms` greatly improves throughput under load.

For throughput-sensitive pipelines, set `linger_ms=20` and `batch_size=131072`. For latency-sensitive pipelines, keep `linger_ms=0`.

## Compression

Kafka supports record compression at the producer level:

```python
producer = KafkaProducer(
    bootstrap_servers="kafka:9092",
    compression_type="snappy",  # none | gzip | snappy | lz4 | zstd
)
```

Compression is applied per batch. Snappy and LZ4 are good defaults — they compress well with minimal CPU overhead. GZIP compresses better but is slower. ZSTD is the best ratio for CPU cost.

Compressed records are stored compressed on the broker and decompressed by the consumer. This reduces both network bandwidth and disk usage — usually a net win for text or JSON data.

## Delivery Guarantees (acks)

The `acks` setting controls how many broker acknowledgments the producer waits for before considering a send successful:

```python
producer = KafkaProducer(
    bootstrap_servers="kafka:9092",
    acks="all",  # 0 | 1 | "all"
)
```

| `acks` | Meaning | Risk |
|--------|---------|------|
| `0` | Fire and forget — no ack waited | Data loss possible |
| `1` | Leader acknowledges (default) | Loss if leader fails before replication |
| `all` (or `-1`) | All in-sync replicas acknowledge | No data loss if ISR ≥ 2 |

For production, use `acks="all"` combined with `min.insync.replicas=2` on the broker. This ensures at least two brokers have the record before the producer gets an ack.

## Retries and Idempotence

Networks fail. A broker can acknowledge a write, then crash before the producer sees the ack. The producer retries — and the record is written twice. This is the duplicate problem.

**Idempotent producers** solve this. The broker assigns each producer a unique ID and a sequence number per partition. If a retry delivers a record the broker has already seen (same producer ID + sequence), the broker deduplicates it silently.

```python
producer = KafkaProducer(
    bootstrap_servers="kafka:9092",
    acks="all",
    enable_idempotence=True,   # enables exactly-once at the producer level
    retries=5,
    max_in_flight_requests_per_connection=5,
)
```

With `enable_idempotence=True`, the producer guarantees **exactly-once delivery to the broker** for each partition. This is the foundation for end-to-end exactly-once with Kafka Transactions.

## Transactions (exactly-once across partitions)

For writing to multiple topics atomically — or for read-process-write pipelines — Kafka supports **transactions**:

```python
producer = KafkaProducer(
    bootstrap_servers="kafka:9092",
    transactional_id="my-producer-1",  # unique per producer instance
    enable_idempotence=True,
    acks="all",
)

producer.init_transactions()

try:
    producer.begin_transaction()
    producer.send("topic-a", key=b"k1", value=b"v1")
    producer.send("topic-b", key=b"k2", value=b"v2")
    producer.commit_transaction()
except Exception:
    producer.abort_transaction()
```

Records inside a transaction are invisible to consumers with `isolation.level=read_committed` until the transaction commits. This enables atomic multi-topic writes.

## Key Takeaways

- The producer **batches** records internally — tune `batch_size` and `linger_ms` for throughput vs latency
- **Compression** (snappy, lz4, zstd) reduces network and disk usage with minimal CPU cost
- `acks="all"` with `min.insync.replicas=2` gives the strongest durability guarantee
- **Idempotent producers** (`enable_idempotence=True`) prevent duplicates from retries
- **Transactions** enable atomic writes across multiple partitions and topics

**Next:** [Consumers & Consumer Groups](/blog/kafka-series-3-consumers)
