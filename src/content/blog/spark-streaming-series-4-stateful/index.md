---
title: "Spark Streaming Series, Part 4: Stateful Processing"
description: "Per-key state tracking across events, timeouts, and RocksDB state stores for complex streaming logic."
pubDate: 2024-03-31
author: "ifkarsyah"
domain: "Streaming"
stack: ["Spark"]
image:
  src: ./spark-streaming-series.png
  alt: "Apache Spark Stateful Processing"
---

## What Is State?

**State** is information Spark tracks about each key across events.

Example: A user's session. As events arrive for user_id=123, Spark maintains a session object:

```
Event 1: user_id=123, click, 10:00 AM  → new session, state = {user: 123, events: [click], last_activity: 10:00}
Event 2: user_id=123, view,  10:05 AM  → update session, state = {user: 123, events: [click, view], last_activity: 10:05}
Event 3: user_id=456, click, 10:06 AM  → new session, state = {user: 456, events: [click], last_activity: 10:06}
```

Each key (user_id) has independent state. State is stored in a **state store** (RocksDB by default) and is **recoverable** — if the job crashes, state is restored.

Windows (from Part 3) are a special case: Spark automatically manages state for window aggregations. Now we discuss arbitrary, custom state.

## Simple State: `mapGroupsWithState`

For many cases, you do not need state management — aggregations suffice. But for complex logic, use `mapGroupsWithState`.

### The API

```python
def aggregate_user_state(user_id, events, state):
    """
    Called once per micro-batch for each key (user_id).

    Args:
        user_id: The key (e.g., 123)
        events: All events for this key in this batch (iterator)
        state: GroupState object for managing state

    Returns:
        Optionally, output rows
    """
    # Read current state (or initialize)
    current_state = state.get() if state.exists else {}

    # Process events
    for event in events:
        current_state["last_event"] = event["event_type"]
        current_state["count"] = current_state.get("count", 0) + 1

    # Update state
    state.update(current_state)

    # Optionally, return output (empty, one row, many rows)
    yield (user_id, current_state["count"], current_state["last_event"])
```

Call it with `.groupByKey()`:

```python
from pyspark.sql.types import StructType, StructField, IntegerType, StringType

result = events \
    .groupByKey(F.col("user_id")) \
    .mapGroupsWithState(
        outputMode="update",  # or "append"
        timeoutConf=GroupStateTimeout.ProcessingTimeTimeout(30 * 60)  # 30 min
    )(aggregate_user_state)
```

The lambda becomes a named function for clarity. Each micro-batch calls this for each key.

### A Complete Example: Session Tracking

```python
from pyspark.sql import SparkSession, functions as F
from pyspark.sql.types import StructType, StructField, LongType, StringType
from pyspark.sql.streaming import GroupStateTimeout

spark = SparkSession.builder.appName("SessionTracking").getOrCreate()

schema = StructType([
    StructField("user_id", LongType()),
    StructField("event_type", StringType()),
])

events = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "broker:9092") \
    .option("subscribe", "events") \
    .load() \
    .select(
        F.from_json(F.col("value").cast("string"), schema).alias("data")
    ).select("data.*")

def track_session(user_id, events_iter, state):
    """Track a user's session — count events, track last event, detect timeout."""

    # Initialize or retrieve state
    if state.exists:
        session = state.get()
    else:
        session = {"event_count": 0, "last_event": None}

    # Process all events in this batch
    event_list = list(events_iter)
    session["event_count"] += len(event_list)
    if event_list:
        session["last_event"] = event_list[-1]["event_type"]

    # Check for timeout (30 minutes of inactivity)
    if state.isTimedOut():
        # Emit final session record, do not update state
        print(f"Session timeout for user {user_id}: {session}")
        return  # no output

    # Update state with new count
    state.update(session)

    # Emit current session state
    yield (user_id, session["event_count"], session["last_event"])

output_schema = StructType([
    StructField("user_id", LongType()),
    StructField("event_count", LongType()),
    StructField("last_event", StringType()),
])

result = events \
    .groupByKey(F.col("user_id")) \
    .mapGroupsWithState(
        outputMode="update",
        timeoutConf=GroupStateTimeout.ProcessingTimeTimeout(30 * 60),  # 30 min timeout
        outputSchema=output_schema
    )(track_session)

query = result.writeStream \
    .outputMode("update") \
    .format("console") \
    .trigger(processingTime="10 seconds") \
    .start()

query.awaitTermination()
```

## Advanced State: `flatMapGroupsWithState`

`flatMapGroupsWithState` is identical to `mapGroupsWithState` but more explicit about handling timeouts.

```python
def track_session_advanced(user_id, events_iter, state):
    """Track sessions with explicit timeout handling."""

    if state.exists:
        session = state.get()
    else:
        session = {"event_count": 0, "last_event": None}

    event_list = list(events_iter)

    if state.isTimedOut():
        # Session expired — emit final record, clear state
        yield (user_id, session["event_count"], "CLOSED")
        state.remove()
    else:
        # Update session
        session["event_count"] += len(event_list)
        if event_list:
            session["last_event"] = event_list[-1]["event_type"]

        state.update(session)
        yield (user_id, session["event_count"], session["last_event"])
```

The difference: `flatMapGroupsWithState` requires you to call `state.remove()` explicitly on timeout. `mapGroupsWithState` handles it.

## State Timeouts

Timeouts prevent state from growing unbounded. Two types:

### Processing Time Timeout

Based on wall-clock time:

```python
GroupStateTimeout.ProcessingTimeTimeout(30 * 60)  # 30 minutes
```

If no events arrive for user_id=123 for 30 minutes, the next event triggers a timeout.

### Event Time Timeout

Based on event time (requires a watermark):

```python
GroupStateTimeout.EventTimeTimeout()

# In your function:
state.setTimeoutTimestamp(event_time + 30 * 60 * 1000)  # 30 min in future
```

More complex, but respects the stream's event time. Requires event-time watermarks.

**Most commonly, use processing-time timeouts.** Event-time timeouts are overkill for most use cases.

## State Store Backends

Spark stores state in a **state store**. The default backend is **RocksDB** — a key-value database embedded in Spark.

For typical workloads, the default is fine. RocksDB writes state to disk, making it fault-tolerant. State is also checkpoint and recovered.

### Querying State (Advanced)

You can inspect state stores, but this is rarely needed:

```python
# State files are written to the checkpoint directory
# checkpoint-dir/state/0/ contains partition 0's state
# checkpoint-dir/state/1/ contains partition 1's state
```

## Complete Streaming Example: User Activity Tracking

```python
from pyspark.sql import SparkSession, functions as F
from pyspark.sql.types import StructType, StructField, LongType, StringType
from pyspark.sql.streaming import GroupStateTimeout

spark = SparkSession.builder.appName("ActivityTracking").getOrCreate()

schema = StructType([
    StructField("user_id", LongType()),
    StructField("activity", StringType()),
    StructField("timestamp", LongType()),
])

# Read events
raw = spark.readStream \
    .format("kafka") \
    .option("kafka.bootstrap.servers", "broker:9092") \
    .option("subscribe", "user-activities") \
    .load()

events = raw.select(
    F.from_json(F.col("value").cast("string"), schema).alias("data")
).select("data.*")

def track_user_activity(user_id, events_iter, state):
    """Track user activity — consecutive login/logout pairs."""

    if state.exists:
        user_state = state.get()
    else:
        user_state = {
            "session_count": 0,
            "current_status": "logged_out",
            "session_start": None,
        }

    event_list = list(events_iter)

    for event in event_list:
        if event["activity"] == "login" and user_state["current_status"] == "logged_out":
            user_state["session_count"] += 1
            user_state["current_status"] = "logged_in"
            user_state["session_start"] = event["timestamp"]

        elif event["activity"] == "logout" and user_state["current_status"] == "logged_in":
            user_state["current_status"] = "logged_out"
            session_duration = event["timestamp"] - user_state["session_start"]
            yield (user_id, user_state["session_count"], session_duration)

    state.update(user_state)

output_schema = StructType([
    StructField("user_id", LongType()),
    StructField("session_count", LongType()),
    StructField("duration_ms", LongType()),
])

sessions = events \
    .groupByKey(F.col("user_id")) \
    .flatMapGroupsWithState(
        outputMode="append",
        timeoutConf=GroupStateTimeout.ProcessingTimeTimeout(60 * 60),  # 1 hour
        outputSchema=output_schema
    )(track_user_activity)

query = sessions.writeStream \
    .outputMode("append") \
    .format("delta") \
    .option("checkpointLocation", "s3://bucket/checkpoint/sessions/") \
    .option("path", "s3://bucket/data/sessions/") \
    .start()

query.awaitTermination()
```

This tracks login/logout pairs per user and emits a session record when a user logs out. State is recovered on failure.

## Key Takeaways

- State tracks per-key information across events (sessions, counters, complex state)
- `mapGroupsWithState` applies a function per key per micro-batch
- `GroupState` provides `.get()`, `.update()`, `.remove()`, `.isTimedOut()`
- Timeouts prevent unbounded state growth — use processing-time timeouts typically
- State is stored in RocksDB (by default) and is recoverable via checkpoints
- For simple aggregations, windows are easier; for complex logic, use stateful operations

Next: Operations and Tuning — checkpointing, fault tolerance, monitoring, and production performance.
