---
title: "Java Concurrency Series, Part 7: Concurrent Collections"
description: "Why can't you just wrap a HashMap in synchronized? Explore ConcurrentHashMap's node-level locking, CopyOnWriteArrayList's snapshot semantics, BlockingQueue variants, and a contention benchmark."
pubDate: 2026-04-13
author: "ifkarsyah"
domain: "Backend"
stack: ["Java"]
image:
  src: ./java-concurrency-series.png
  alt: "Java Concurrency Internals"
---

You've learned the building blocks: locks, atomics, thread pools. Now let's apply them to the data structures you actually use. `Collections.synchronizedMap(new HashMap<>())` is correct but serializes every operation. `ConcurrentHashMap` handles hundreds of thousands of operations per second by using fundamentally different internals.

**Key question:** Why can't you just wrap a `HashMap` in `synchronized`?

## The Problem with `synchronizedMap`

```java
Map<String, Integer> map = Collections.synchronizedMap(new HashMap<>());

// Correct usage requires external synchronization for compound operations:
synchronized (map) {
    if (!map.containsKey(key)) {
        map.put(key, computeValue(key));
    }
}
```

`synchronizedMap` wraps each method with `synchronized(this)` — a single lock for the entire map. Under concurrent access:

- Every `get` blocks every `put`
- Every `put` blocks every other `put`
- All threads serialize through one monitor

For a map with 1 million reads/second across 16 threads, they all queue on one lock. Throughput doesn't scale with thread count — it degrades.

## `ConcurrentHashMap` Internals

`ConcurrentHashMap` (Java 8+) uses a completely different strategy:

```
┌──────────────────────────────────────────────────────┐
│ ConcurrentHashMap (16+ buckets)                      │
│                                                      │
│  [0]  → Node(k1,v1) → Node(k2,v2)                   │
│  [1]  → Node(k3,v3)                                  │
│  [2]  → (empty)                                      │
│  ...                                                 │
│  [15] → TreeNode (when bucket size > 8)              │
└──────────────────────────────────────────────────────┘
```

Key design decisions:

1. **No global lock.** Reads use `volatile` fields — no lock at all for `get`.
2. **Node-level locking.** Each bucket's head node is the lock for that bucket. Only the first insertion into a bucket uses CAS; subsequent insertions lock only the head node.
3. **Tree bins.** When a bucket has more than 8 entries, it converts to a red-black tree for O(log n) operations.
4. **Size tracking.** Uses a `LongAdder`-like `CounterCell` array — no global counter lock.

```java
// get() — no lock at all
public V get(Object key) {
    Node<K,V>[] tab; Node<K,V> e, p; int n, eh; K ek;
    int h = spread(key.hashCode());
    if ((tab = table) != null && (n = tab.length) > 0 &&
        (e = tabAt(tab, (n - 1) & h)) != null) {  // volatile read of bucket head
        // walk chain...
    }
    return null;
}
```

`tabAt` is a `Unsafe.getObjectVolatile` — a volatile read of the array slot. No lock.

## `ConcurrentHashMap` vs `synchronizedMap` Benchmark

```java
@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.MILLISECONDS)
@State(Scope.Benchmark)
@Threads(16)
public class MapBenchmark {
    private final Map<Integer, Integer> syncMap =
        Collections.synchronizedMap(new HashMap<>());
    private final ConcurrentHashMap<Integer, Integer> concMap =
        new ConcurrentHashMap<>();

    @Setup
    public void setup() {
        for (int i = 0; i < 10_000; i++) {
            syncMap.put(i, i);
            concMap.put(i, i);
        }
    }

    @Benchmark
    public Integer syncMapGet() {
        return syncMap.get(ThreadLocalRandom.current().nextInt(10_000));
    }

    @Benchmark
    public Integer concMapGet() {
        return concMap.get(ThreadLocalRandom.current().nextInt(10_000));
    }
}
```

Typical results (16 threads, read-only):

```
Benchmark             Mode  Cnt       Score      Error  Units
MapBenchmark.syncMapGet  thrpt   25   6,123,891 ±  45,231  ops/ms
MapBenchmark.concMapGet  thrpt   25  89,341,289 ± 134,123  ops/ms
```

~14x throughput improvement. The gap grows with more threads.

## Atomic Compound Operations

`ConcurrentHashMap` provides atomic compound operations that don't need external locking:

```java
ConcurrentHashMap<String, Integer> counts = new ConcurrentHashMap<>();

// Atomic putIfAbsent — returns existing value or null
counts.putIfAbsent("key", 0);

// Atomic computeIfAbsent — compute only if missing
counts.computeIfAbsent("key", k -> expensiveCompute(k));

// Atomic merge — add to existing or insert new
counts.merge("key", 1, Integer::sum);

// Atomic compute — update existing or create new
counts.compute("key", (k, v) -> v == null ? 1 : v + 1);
```

These are all atomic within the bucket's lock scope. Do NOT do this:

```java
// WRONG — not atomic
if (!map.containsKey(key)) {
    map.put(key, compute(key));  // race between containsKey and put
}

// RIGHT — atomic
map.computeIfAbsent(key, k -> compute(k));
```

## `CopyOnWriteArrayList`

For lists where reads vastly outnumber writes:

```java
CopyOnWriteArrayList<EventListener> listeners = new CopyOnWriteArrayList<>();
```

On every write (add, set, remove), it creates a full copy of the backing array:

```
Before add: [L1, L2, L3]
After add:  [L1, L2, L3, L4]  (new array; old array still in use by readers)
```

Reads operate on the **snapshot** of the array at the time the read started — no lock, always consistent.

```java
// Zero lock on reads
for (EventListener listener : listeners) {  // reads the snapshot
    listener.onEvent(event);
}

// Writes are expensive (full copy)
listeners.add(newListener);
```

Use `CopyOnWriteArrayList` for:
- Event listener lists (added/removed rarely)
- Configuration lists (updated occasionally)
- Any list read in a hot path but rarely modified

Do NOT use it for large lists with frequent modifications — copying is O(n) per write.

## `BlockingQueue`: Producer-Consumer Infrastructure

`BlockingQueue` is the standard Java interface for bounded producer-consumer channels. All implementations are thread-safe.

### `ArrayBlockingQueue` (bounded, fair optional)

```java
BlockingQueue<Task> queue = new ArrayBlockingQueue<>(1000);

// Producer — blocks if full
queue.put(task);                    // blocking
queue.offer(task, 1, TimeUnit.SECONDS);  // with timeout

// Consumer — blocks if empty
Task task = queue.take();           // blocking
Task task = queue.poll(1, TimeUnit.SECONDS);  // with timeout
```

### `LinkedBlockingQueue` (optionally bounded)

```java
// Unbounded (dangerous in production)
BlockingQueue<Task> unbounded = new LinkedBlockingQueue<>();

// Bounded
BlockingQueue<Task> bounded = new LinkedBlockingQueue<>(1000);
```

Uses separate locks for producers (tail) and consumers (head) — higher throughput than `ArrayBlockingQueue` under mixed load.

### `SynchronousQueue` (no storage — handoff only)

```java
SynchronousQueue<Task> handoff = new SynchronousQueue<>();
```

`put` blocks until a consumer calls `take`. No buffering. Used by `Executors.newCachedThreadPool()` to hand tasks directly to idle threads.

### `PriorityBlockingQueue` (ordered, unbounded)

```java
PriorityBlockingQueue<Task> pq = new PriorityBlockingQueue<>(
    100,
    Comparator.comparingInt(Task::getPriority)
);
```

Highest-priority task is taken first. Unbounded — add backpressure externally.

## `BlockingQueue` as a Thread Pool Input

The standard pattern for a custom executor:

```java
BlockingQueue<Runnable> workQueue = new ArrayBlockingQueue<>(500);
ExecutorService pool = new ThreadPoolExecutor(
    4, 8, 60, TimeUnit.SECONDS,
    workQueue,
    new ThreadPoolExecutor.CallerRunsPolicy()
);

// Observe queue depth
ScheduledExecutorService monitor = Executors.newSingleThreadScheduledExecutor();
monitor.scheduleAtFixedRate(
    () -> System.out.println("Queue depth: " + workQueue.size()),
    0, 5, TimeUnit.SECONDS
);
```

## `ConcurrentSkipListMap`: Sorted Concurrent Map

When you need sorted order with concurrent access:

```java
ConcurrentSkipListMap<Long, Event> eventLog = new ConcurrentSkipListMap<>();

eventLog.put(System.nanoTime(), new Event("login"));
eventLog.put(System.nanoTime(), new Event("click"));

// Efficient sorted operations
Map.Entry<Long, Event> earliest = eventLog.firstEntry();
NavigableMap<Long, Event> recent = eventLog.tailMap(cutoff, true);
```

A skip list is a probabilistic data structure — multiple levels of linked lists. Insertions and lookups are O(log n) on average, and it naturally supports concurrent access by locking only the nodes being modified.

## `ConcurrentLinkedQueue`: Lock-Free FIFO

```java
Queue<Task> queue = new ConcurrentLinkedQueue<>();
queue.offer(task);     // always succeeds (unbounded)
Task task = queue.poll(); // returns null if empty (non-blocking)
```

Uses a Michael-Scott lock-free algorithm built on CAS operations. Best for unbounded FIFO where you don't need backpressure (use `BlockingQueue` if you do).

## Pitfall: Iteration is Not Atomic

All concurrent collections allow concurrent modification during iteration — but don't throw `ConcurrentModificationException`. The iterator reflects the state at a point in time, not a transactional snapshot.

```java
ConcurrentHashMap<String, Integer> map = new ConcurrentHashMap<>();
map.put("a", 1);
map.put("b", 2);

for (Map.Entry<String, Integer> entry : map.entrySet()) {
    System.out.println(entry.getKey() + "=" + entry.getValue());
    map.put("c", 3);  // safe — won't throw, but "c" may or may not appear in iteration
}
```

For a consistent snapshot, copy the entries:

```java
new HashMap<>(concurrentMap).forEach((k, v) -> process(k, v));
```

## Choosing the Right Collection

| Need | Use |
|------|-----|
| General key-value, concurrent access | `ConcurrentHashMap` |
| Key-value with sorted order | `ConcurrentSkipListMap` |
| Read-heavy list (listeners, config) | `CopyOnWriteArrayList` |
| Bounded producer-consumer channel | `ArrayBlockingQueue` |
| Unbounded FIFO (no backpressure needed) | `ConcurrentLinkedQueue` |
| Direct thread handoff | `SynchronousQueue` |
| Priority-ordered tasks | `PriorityBlockingQueue` |

## Troubleshooting: False Sharing

`ConcurrentHashMap` and `LongAdder` are designed to avoid **false sharing** — where two unrelated variables happen to land in the same CPU cache line (~64 bytes), causing cache invalidation even though they're logically independent.

The `@Contended` annotation (JVM internal) pads fields to avoid this:

```java
// OpenJDK's CounterCell inside ConcurrentHashMap:
@jdk.internal.vm.annotation.Contended
static final class CounterCell {
    volatile long value;
}
```

If you're writing your own high-performance data structure with multiple counters, pad them:

```java
@sun.misc.Contended
static class PaddedCounter {
    volatile long value;
    // JVM adds ~128 bytes of padding
}
```

## Summary

| Concept | Key Point |
|---------|-----------|
| `synchronizedMap` | Single lock; serializes all operations |
| `ConcurrentHashMap` get | No lock — volatile read of bucket head |
| `ConcurrentHashMap` put | CAS for empty bucket; locks only the bucket's head node |
| `CopyOnWriteArrayList` | Full array copy on write; lock-free reads |
| `BlockingQueue` | Thread-safe channel with blocking semantics |
| `ConcurrentSkipListMap` | Sorted, concurrent, O(log n) |
| Iteration | Concurrent modifications allowed; use copy for consistency |

**Next:** In Part 8, the final part, we explore Java 21 virtual threads. They change the entire economics of threading — and require re-examining everything we've learned about thread pools and blocking operations.

---

**Part 7 complete. Next: [Virtual Threads & Project Loom](/blog/java-concurrency-series-8-virtual-threads/)**
