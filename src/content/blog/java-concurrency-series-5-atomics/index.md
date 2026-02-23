---
title: "Java Concurrency Series, Part 5: Atomic Operations & Lock-Free Programming"
description: "How can you update shared state without any lock? Understand the CAS CPU instruction, AtomicInteger, the ABA problem, LongAdder's striping trick, and VarHandle memory access modes."
pubDate: 2026-03-30
author: "ifkarsyah"
domain: "Backend"
stack: ["Java"]
image:
  src: ./java-concurrency-series.png
  alt: "Java Concurrency Internals"
---

We've seen that locks guarantee correctness but impose overhead: blocking, context switching, and cache invalidation. For simple shared variables — counters, flags, references — there's a better approach. Hardware supports **atomic** read-modify-write operations that complete without any lock.

**Key question:** How can you update shared state without any lock?

## Compare-And-Swap (CAS)

The foundation of all lock-free programming is the **compare-and-swap** (CAS) instruction. On x86-64 it's `LOCK CMPXCHG`. The semantics:

```
CAS(address, expected, new_value):
    atomically:
        if *address == expected:
            *address = new_value
            return true
        else:
            return false
```

This is atomic at the hardware level — no other CPU can interleave. The `LOCK` prefix on x86 ensures the operation is globally visible across all cores.

CAS is the primitive used by:
- `AtomicInteger`, `AtomicLong`, `AtomicReference`
- `ReentrantLock` (for the state field in AQS)
- `ConcurrentHashMap` (for node insertion)
- `LongAdder`, `ConcurrentLinkedQueue`

## `AtomicInteger`: CAS in Java

```java
AtomicInteger counter = new AtomicInteger(0);

// Atomic increment — equivalent to i++ but thread-safe
int oldValue = counter.getAndIncrement();

// CAS directly
boolean success = counter.compareAndSet(5, 6); // if 5, set to 6

// Compute atomically
int result = counter.updateAndGet(v -> v * 2);
```

Under the hood, `getAndIncrement()` is:

```java
// Simplified view of OpenJDK source
public int getAndIncrement() {
    return U.getAndAddInt(this, VALUE, 1);
}
// U is Unsafe; VALUE is the field offset
// This compiles to LOCK XADD on x86
```

No mutex, no syscall — just a single CPU instruction with the LOCK prefix.

## The CAS Loop Pattern

When CAS fails (another thread modified the value), you retry:

```java
AtomicInteger value = new AtomicInteger(0);

// Manually implement getAndMultiply (not in standard library)
int prev, next;
do {
    prev = value.get();
    next = prev * 2;
} while (!value.compareAndSet(prev, next));
```

This is called a **CAS loop** or **optimistic concurrency**: assume no conflict, try, and retry if there was one. Under low contention, this is nearly always fast. Under high contention, threads spin — which is why `AtomicLong` is bad as a high-throughput counter.

## The ABA Problem

CAS only checks if the value equals the expected. It can't tell if the value was changed from A to B and back to A:

```
Thread 1 reads: value = A
Thread 2 changes: A → B → A
Thread 1 CAS(A, C) succeeds — but the value has changed underneath!
```

For most numeric counters, ABA doesn't matter. But for linked list node pointers, it can corrupt data structure invariants.

Fix: use a version stamp alongside the value.

```java
AtomicStampedReference<Node> ref = new AtomicStampedReference<>(node, 0);

int[] stampHolder = new int[1];
Node current = ref.get(stampHolder);
int stamp = stampHolder[0];

// Only succeeds if both the reference AND the stamp match
ref.compareAndSet(current, newNode, stamp, stamp + 1);
```

`AtomicMarkableReference<V>` is a simpler variant with a boolean mark rather than an integer stamp — useful for "logically deleted" nodes in concurrent linked lists.

## `LongAdder`: High-Throughput Counters

`AtomicLong` with a CAS loop under heavy contention becomes a bottleneck — many threads spin-retrying the same memory location.

`LongAdder` (Java 8) solves this by **striping** the counter across multiple cells:

```
┌──────────────────────────────────────┐
│ LongAdder                            │
│                                      │
│  base: 100                           │
│  cells: [Cell(+5), Cell(+3), Cell(+7)]│
│                                      │
│  sum() = base + all cells = 115      │
└──────────────────────────────────────┘
```

Each thread writes to its own cell (assigned by thread ID hash). Contention is distributed. The true total is computed by `sum()` — which traverses all cells and adds `base`.

```java
LongAdder counter = new LongAdder();
counter.increment();
counter.add(5);
long total = counter.sum(); // approximate but fast
```

Note: `sum()` is not atomic. Between cells being read, other threads can increment them. Use `LongAdder` for metrics and statistics where you tolerate this. Use `AtomicLong` when you need an exact value at a point in time.

## Benchmark: AtomicLong vs LongAdder vs synchronized

```java
@BenchmarkMode(Mode.Throughput)
@OutputTimeUnit(TimeUnit.MILLISECONDS)
@State(Scope.Benchmark)
@Threads(16)
public class CounterBenchmark {
    private final AtomicLong atomicLong = new AtomicLong();
    private final LongAdder longAdder = new LongAdder();
    private long syncCounter = 0;
    private final Object lock = new Object();

    @Benchmark
    public void atomicLong() {
        atomicLong.incrementAndGet();
    }

    @Benchmark
    public void longAdder() {
        longAdder.increment();
    }

    @Benchmark
    public void synchronized_counter() {
        synchronized (lock) { syncCounter++; }
    }
}
```

Typical results (16 threads):

```
Benchmark                         Mode  Cnt       Score      Error  Units
CounterBenchmark.atomicLong      thrpt   25   8,234,123 ±  45,231  ops/ms
CounterBenchmark.longAdder       thrpt   25  87,341,289 ± 234,123  ops/ms
CounterBenchmark.synchronized_counter thrpt 25   5,123,891 ±  34,123  ops/ms
```

`LongAdder` is ~10x faster than `AtomicLong` under high contention, and ~17x faster than `synchronized`.

## `AtomicReference`: Lock-Free Object Updates

```java
AtomicReference<Config> currentConfig = new AtomicReference<>(initialConfig);

// Thread-safe config swap
Config prev = currentConfig.get();
Config updated = prev.withTimeout(500);
currentConfig.compareAndSet(prev, updated);
```

A common pattern: immutable objects + `AtomicReference`. Instead of locking to update a complex object, create a new immutable version and CAS the reference. Readers always get a consistent snapshot.

```java
// Thread-safe stats object
record Stats(long count, long totalMs) {
    Stats add(long ms) { return new Stats(count + 1, totalMs + ms); }
}

AtomicReference<Stats> stats = new AtomicReference<>(new Stats(0, 0));

// From any thread, no lock needed
stats.updateAndGet(s -> s.add(elapsedMs));
```

## `VarHandle`: Java 9+ Fine-Grained Access

`VarHandle` (Java 9) is a type-safe replacement for `Unsafe` field access. It gives you explicit control over memory ordering modes:

```java
public class Node<T> {
    T value;
    volatile Node<T> next;  // declared volatile for VarHandle access

    private static final VarHandle NEXT;
    static {
        try {
            NEXT = MethodHandles.lookup()
                .findVarHandle(Node.class, "next", Node.class);
        } catch (ReflectiveOperationException e) {
            throw new Error(e);
        }
    }

    // Plain (no memory barriers — fastest, only safe for single-threaded access)
    Node<T> getNextPlain() {
        return (Node<T>) NEXT.get(this);
    }

    // Opaque (ensures coherent reads/writes to this field)
    Node<T> getNextOpaque() {
        return (Node<T>) NEXT.getOpaque(this);
    }

    // Acquire/Release (partial ordering, cheaper than volatile on ARM)
    Node<T> getNextAcquire() {
        return (Node<T>) NEXT.getAcquire(this);
    }

    // Volatile (full happens-before; same as volatile field access)
    Node<T> getNextVolatile() {
        return (Node<T>) NEXT.getVolatile(this);
    }

    // CAS
    boolean casNext(Node<T> expected, Node<T> newNext) {
        return NEXT.compareAndSet(this, expected, newNext);
    }
}
```

Memory access modes from weakest to strongest:

| Mode | Guarantees | Cost |
|------|-----------|------|
| `plain` | None — compiler/CPU can reorder freely | Lowest |
| `opaque` | Coherent (no out-of-thin-air reads) | Low |
| `acquire` (read) / `release` (write) | One-sided happens-before | Medium |
| `volatile` | Full happens-before (same as `volatile` keyword) | Highest |

`acquire`/`release` is the sweet spot on ARM-based systems (Apple M-series, AWS Graviton) — cheaper than full `volatile` barriers but stronger than `opaque`.

## Lock-Free Stack Example

A canonical lock-free data structure: a Treiber stack.

```java
public class LockFreeStack<T> {
    private final AtomicReference<Node<T>> top = new AtomicReference<>();

    public void push(T value) {
        Node<T> newNode = new Node<>(value);
        Node<T> oldTop;
        do {
            oldTop = top.get();
            newNode.next = oldTop;
        } while (!top.compareAndSet(oldTop, newNode));
    }

    public T pop() {
        Node<T> oldTop;
        Node<T> newTop;
        do {
            oldTop = top.get();
            if (oldTop == null) return null;
            newTop = oldTop.next;
        } while (!top.compareAndSet(oldTop, newTop));
        return oldTop.value;
    }

    private static class Node<T> {
        final T value;
        Node<T> next;
        Node(T value) { this.value = value; }
    }
}
```

No locks. Each CAS loop retries only when another thread concurrently modified the top. Under low contention, push/pop complete in one CAS attempt.

## When to Use What

| Scenario | Tool |
|----------|------|
| Simple counter (stats, metrics) | `LongAdder` |
| Counter where you need exact point-in-time value | `AtomicLong` |
| Swap a reference to an immutable object | `AtomicReference` |
| Counter or reference with ABA concern | `AtomicStampedReference` |
| Custom lock or data structure internals | `VarHandle` |
| Flag (stop signal, initialized state) | `AtomicBoolean` or `volatile boolean` |

## Troubleshooting: Spinning Under Contention

If a CAS loop spins a lot, threads burn CPU without making progress. Diagnose with:

```bash
# High CPU + low throughput = contention
top -H -p <pid>   # per-thread CPU usage

# JFR: "Java Monitor Blocked" or thread CPU profiling
jcmd <pid> JFR.start duration=30s filename=profile.jfr
```

Signs of excessive CAS contention:
- CPU utilization near 100% but throughput is low
- JMH shows "retries" increasing with thread count

Solutions:
- Switch to `LongAdder` for counters
- Reduce shared state — partition by thread/shard
- Use `Striped<Lock>` from Guava for fine-grained locking

## Summary

| Concept | Key Point |
|---------|-----------|
| CAS | CPU `LOCK CMPXCHG`; atomic read-modify-write |
| CAS loop | Retry on failure; efficient under low contention |
| ABA problem | CAS can't detect A→B→A; use `AtomicStampedReference` |
| `LongAdder` | Striped counter; ~10x faster than `AtomicLong` at high contention |
| `AtomicReference` | Combine with immutable objects for lock-free updates |
| `VarHandle` | Fine-grained memory access modes; CAS on arbitrary fields |

**Next:** In Part 6, we'll zoom out from individual data structures to thread pools. `ThreadPoolExecutor` manages a pool of workers and a queue — and misconfiguring it causes subtle, hard-to-diagnose production failures.

---

**Part 5 complete. Next: [Thread Pools & Executors](/blog/java-concurrency-series-6-thread-pools/)**
