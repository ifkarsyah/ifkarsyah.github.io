---
title: "Flink Series, Part 3: State Management"
description: "How Flink stores and manages state — keyed vs operator state, state backends, TTL, and practical stateful patterns."
pubDate: 2024-02-25
author: "ifkarsyah"
domain: "Streaming"
stack: ["Flink"]
image:
  src: ./flink-series.png
  alt: "Apache Flink State Management"
---

## Why State Matters

A stateless transformation (map, filter) needs no memory of the past — each event is processed independently. But most interesting streaming problems are inherently stateful:

- **Running totals**: how many events has this user generated so far?
- **Sessionization**: group events into sessions based on inactivity gaps
- **Pattern detection**: alert when three failed logins happen within one minute
- **Deduplication**: have I seen this event ID before?

In a traditional stream processor, you'd reach for a database or Redis to store this state. Flink internalizes state management — it keeps state co-located with the computation, manages its lifecycle, and snapshots it for fault tolerance.

## Keyed State vs Operator State

Flink has two categories of state:

**Keyed state** is the most common. After a `keyBy`, each key has its own isolated state. If you `keyBy(user_id)`, user 42's state is completely separate from user 99's state. Keyed state is partitioned automatically across TaskManagers.

**Operator state** is attached to a specific operator instance rather than a key. Used for sources and sinks — for example, a Kafka source uses operator state to track which offsets have been consumed per partition.

For application logic, you will almost always use keyed state.

## State Primitives

Flink provides typed state descriptors that you declare in `open()` and use in `process()`:

**ValueState** — stores a single value per key:
```python
from pyflink.datastream.state import ValueStateDescriptor
from pyflink.common.typeinfo import Types

class EventCounter(KeyedProcessFunction):
    def open(self, runtime_context):
        descriptor = ValueStateDescriptor("count", Types.LONG())
        self.count_state = runtime_context.get_state(descriptor)

    def process_element(self, value, ctx, out):
        current = self.count_state.value() or 0
        self.count_state.update(current + 1)
        out.collect((value["user_id"], current + 1))
```

**ListState** — stores a list of values per key:
```python
from pyflink.datastream.state import ListStateDescriptor

descriptor = ListStateDescriptor("recent_events", Types.STRING())
self.list_state = runtime_context.get_list_state(descriptor)

# Add and read
self.list_state.add(event["id"])
events = list(self.list_state.get())
```

**MapState** — stores a key-value map per key:
```python
from pyflink.datastream.state import MapStateDescriptor

descriptor = MapStateDescriptor("counts_by_type", Types.STRING(), Types.LONG())
self.map_state = runtime_context.get_map_state(descriptor)

count = self.map_state.get(event["type"]) or 0
self.map_state.put(event["type"], count + 1)
```

**ReducingState / AggregatingState** — automatically aggregate on each update, keeping only the aggregated result (memory-efficient for running sums/averages).

## State Backends

Where does state actually live? Flink supports multiple **state backends**:

**HashMapStateBackend** (default) — state lives in the JVM heap of each TaskManager. Fast reads and writes, but limited by available memory. Good for small-to-medium state.

**EmbeddedRocksDBStateBackend** — state is stored in RocksDB (an embedded key-value store on local disk). Can handle **terabytes of state per TaskManager**. Slightly slower due to serialization, but essential for large-scale stateful jobs.

```python
from pyflink.datastream.state_backend import EmbeddedRocksDBStateBackend

env.set_state_backend(EmbeddedRocksDBStateBackend())
```

For production jobs with non-trivial state, default to RocksDB. The latency overhead is small and the capacity advantage is enormous.

## State TTL

State that grows forever is a liability. Flink's **State TTL** allows you to automatically expire state after a configurable duration:

```python
from pyflink.datastream.state import StateTtlConfig
from pyflink.common import Time

ttl_config = StateTtlConfig \
    .new_builder(Time.hours(24)) \
    .set_update_type(StateTtlConfig.UpdateType.OnCreateAndWrite) \
    .set_state_visibility(StateTtlConfig.StateVisibility.NeverReturnExpired) \
    .build()

descriptor = ValueStateDescriptor("session_data", Types.STRING())
descriptor.enable_time_to_live(ttl_config)
```

`UpdateType.OnCreateAndWrite` — TTL resets every time the state is written (good for sessions).
`UpdateType.OnReadAndWrite` — TTL resets on reads too (useful for "last-active" tracking).

Expired state is cleaned up lazily (on next access) or eagerly in the background. For RocksDB, background compaction handles cleanup efficiently.

## Practical Example: Sessionization

Group events into sessions with a 30-minute inactivity timeout:

```python
from pyflink.datastream.functions import KeyedProcessFunction
from pyflink.datastream.timerservice import TimerService

class Sessionizer(KeyedProcessFunction):
    def open(self, ctx):
        self.session_start = ctx.get_state(
            ValueStateDescriptor("session_start", Types.LONG())
        )
        self.event_count = ctx.get_state(
            ValueStateDescriptor("event_count", Types.LONG())
        )

    def process_element(self, event, ctx, out):
        now = ctx.timestamp()
        TIMEOUT = 30 * 60 * 1000  # 30 minutes in ms

        if self.session_start.value() is None:
            self.session_start.update(now)
            self.event_count.update(0)

        self.event_count.update(self.event_count.value() + 1)

        # Register a timer to fire if no events arrive in 30 min
        ctx.timer_service().delete_event_time_timer(now)
        ctx.timer_service().register_event_time_timer(now + TIMEOUT)

    def on_timer(self, timestamp, ctx, out):
        # Timer fired — session is complete
        out.collect({
            "user_id": ctx.get_current_key(),
            "session_start": self.session_start.value(),
            "session_end": timestamp,
            "event_count": self.event_count.value(),
        })
        self.session_start.clear()
        self.event_count.clear()
```

This pattern — state + timers — is the foundation of most complex stream processing logic.

## Key Takeaways

- Use **keyed state** for application logic; it is partitioned and isolated per key
- Choose your state primitive based on what you need to store: single value, list, or map
- Use **RocksDB** backend for large state; HashMapStateBackend for small/fast workloads
- Configure **TTL** to prevent unbounded state growth
- Timers (registered via `TimerService`) enable time-based state eviction and session patterns

Next: Exactly-Once & Checkpointing — how Flink guarantees correctness after failures.
