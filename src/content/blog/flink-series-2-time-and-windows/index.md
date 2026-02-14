---
title: "Flink Series, Part 2: Time & Windows"
description: "Flink's most powerful feature — temporal reasoning over streams. Event time, watermarks, and window types explained."
pubDate: 2024-02-18
author: "ifkarsyah"
tags: ["Flink", "Data Engineering", "Streaming"]
image:
  src: ./flink-series.png
  alt: "Apache Flink Time and Windows"
---

## The Time Problem in Streaming

In a batch system, time is simple — all your data already exists, so "when did this happen?" is answered by reading the timestamp field.

In streaming, time is messy. Events arrive **out of order**. A mobile app event might be generated at 10:00:00 but arrive at your Kafka topic at 10:00:45 because the device was briefly offline. A network retry can deliver the same event twice.

Flink solves this with a rigorous notion of time and a mechanism — **watermarks** — for reasoning about completeness.

## Three Notions of Time

**Event time** — the timestamp embedded in the event itself, set by the producer. This is the "real" time when something happened. Most analytical queries should use event time.

**Processing time** — the wall-clock time on the Flink TaskManager when the event is processed. Simple, but results change depending on how fast your cluster is and how delayed events arrive.

**Ingestion time** — the time when Flink first reads the event. A compromise between the two — less unpredictable than processing time, but not as accurate as event time.

For correctness, use event time. For simplicity (and when ordering doesn't matter), processing time is fine.

## Watermarks

A **watermark** is a progress signal. A watermark with timestamp `T` asserts: "I believe all events with event time ≤ T have now arrived." Anything that arrives after the watermark for its time window is considered **late data**.

Watermarks let Flink decide when a time window is "done" and can be emitted.

```python
from pyflink.common import WatermarkStrategy, Duration
from pyflink.common.watermark_strategy import TimestampAssigner

# Built-in: allow up to 5 seconds of out-of-order
strategy = WatermarkStrategy \
    .for_bounded_out_of_orderness(Duration.of_seconds(5)) \
    .with_timestamp_assigner(
        lambda event, _: event["timestamp_ms"]
    )

stream = env.from_source(source, strategy, "Kafka Source")
```

With `for_bounded_out_of_orderness(5s)`, Flink will wait 5 seconds beyond the maximum seen event time before closing a window. Events arriving more than 5 seconds late will be dropped (or handled via a side output).

## Window Types

Windows group a stream of events into finite buckets for aggregation. Flink has three main window types:

### Tumbling Windows

Non-overlapping, fixed-size windows. Every event belongs to exactly one window.

```python
from pyflink.datastream.window import TumblingEventTimeWindows
from pyflink.common import Time

stream \
    .key_by(lambda e: e["user_id"]) \
    .window(TumblingEventTimeWindows.of(Time.minutes(5))) \
    .reduce(lambda a, b: a + b)
```

Use case: "count events per user per 5-minute period."

### Sliding Windows

Overlapping windows. Each window is `size` wide and advances by `slide`. An event may belong to multiple windows.

```python
from pyflink.datastream.window import SlidingEventTimeWindows

stream \
    .key_by(lambda e: e["user_id"]) \
    .window(SlidingEventTimeWindows.of(Time.minutes(10), Time.minutes(5))) \
    .reduce(lambda a, b: a + b)
```

Here, a 10-minute window slides every 5 minutes — each event appears in two windows. Use case: "rolling 10-minute average, updated every 5 minutes."

### Session Windows

Windows that close after a period of inactivity. Two events are in the same session if they are separated by less than the gap duration.

```python
from pyflink.datastream.window import EventTimeSessionWindows

stream \
    .key_by(lambda e: e["user_id"]) \
    .window(EventTimeSessionWindows.with_gap(Time.minutes(30))) \
    .reduce(lambda a, b: a + b)
```

Use case: "count events per user session, where a session ends after 30 minutes of inactivity."

## Window Functions

The window type defines the grouping; the **window function** defines what to compute.

**ReduceFunction** — incremental aggregation, low memory:
```python
.reduce(lambda a, b: {"count": a["count"] + b["count"]})
```

**ProcessWindowFunction** — full access to all elements and window metadata (start/end time), higher memory:
```python
from pyflink.datastream.functions import ProcessWindowFunction

class CountWithTime(ProcessWindowFunction):
    def process(self, key, context, elements, out):
        count = sum(1 for _ in elements)
        window_end = context.window().end
        out.collect(f"{key}: {count} events ending at {window_end}")
```

For most aggregations, prefer `ReduceFunction` for efficiency. Use `ProcessWindowFunction` when you need the window's metadata or need to inspect all elements together.

## Late Data and Side Outputs

By default, late data (arriving after the watermark has passed) is dropped. You can instead redirect it to a **side output** for separate handling:

```python
from pyflink.datastream import OutputTag

late_tag = OutputTag("late-data")

main_stream = stream \
    .key_by(lambda e: e["user_id"]) \
    .window(TumblingEventTimeWindows.of(Time.minutes(5))) \
    .allowed_lateness(Time.minutes(1)) \
    .side_output_late_data(late_tag) \
    .reduce(lambda a, b: a + b)

late_stream = main_stream.get_side_output(late_tag)
late_stream.print()  # log or reprocess late arrivals
```

`.allowed_lateness(1 minute)` extends the window's lifetime: even after the watermark passes, the window accepts late data for one more minute and re-fires the result.

## Key Takeaways

- Use **event time** for correct results; use processing time only when simplicity matters more than accuracy
- **Watermarks** signal progress and let Flink decide when windows are complete
- **Tumbling windows** are non-overlapping; **sliding windows** overlap; **session windows** are activity-based
- `ReduceFunction` is memory-efficient; `ProcessWindowFunction` is expressive
- Handle late data with `.allowed_lateness()` and side outputs

Next: State Management — how Flink stores and manages state across events, and how that state survives failures.
