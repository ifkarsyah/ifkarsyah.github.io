---
title: "Java Concurrency Series, Part 4: java.util.concurrent Building Blocks"
description: "Why does ReentrantLock exist if synchronized works? Explore tryLock, StampedLock optimistic reads, Condition variables, and LockSupport — the primitives that underpin all of java.util.concurrent."
pubDate: 2026-03-23
author: "ifkarsyah"
domain: "Backend"
stack: ["Java"]
image:
  src: ./java-concurrency-series.png
  alt: "Java Concurrency Internals"
---

`synchronized` works. But it has limitations: you can't try to acquire a lock with a timeout, you can't interrupt a thread waiting for a `synchronized` monitor, and you can't have multiple condition queues. Java 5 introduced `java.util.concurrent.locks` to address all of this.

**Key question:** Why does `ReentrantLock` exist if `synchronized` already works?

## The Limitations of `synchronized`

With `synchronized`, if a thread blocks waiting for a monitor, it will wait forever — or until the holder releases it. You can't:

- **Try to acquire** without blocking (`tryLock`)
- **Wait with a timeout** (give up after N milliseconds)
- **Interrupt** a thread waiting for the lock
- **Use multiple condition queues** (one wait set per object)
- **Implement fairness** (threads queue in arrival order)

`ReentrantLock` provides all of these.

## `ReentrantLock`: The Basics

```java
import java.util.concurrent.locks.ReentrantLock;

ReentrantLock lock = new ReentrantLock();

lock.lock();
try {
    // critical section
} finally {
    lock.unlock();  // ALWAYS in finally
}
```

Always use `try/finally`. If you forget `unlock()`, the lock is never released — every thread waiting will block forever.

## `tryLock`: Non-Blocking Acquisition

```java
if (lock.tryLock()) {
    try {
        // got the lock
    } finally {
        lock.unlock();
    }
} else {
    // couldn't get it — do something else
}
```

With timeout:

```java
if (lock.tryLock(500, TimeUnit.MILLISECONDS)) {
    try {
        doWork();
    } finally {
        lock.unlock();
    }
} else {
    // timed out
    log.warn("Could not acquire lock within 500ms");
}
```

This is the key deadlock-avoidance tool. If your system has multiple locks, always acquire them with `tryLock` + timeout + backoff rather than unbounded `lock()`.

## Interruptible Lock Acquisition

```java
lock.lockInterruptibly();  // throws InterruptedException if interrupted while waiting
```

With `synchronized`, a thread waiting for a monitor cannot be interrupted. With `lockInterruptibly()`, you can cancel the wait:

```java
Thread worker = new Thread(() -> {
    try {
        lock.lockInterruptibly();
        try {
            doLongWork();
        } finally {
            lock.unlock();
        }
    } catch (InterruptedException e) {
        System.out.println("Lock wait was interrupted");
    }
});

worker.start();
Thread.sleep(100);
worker.interrupt(); // cancels the lock wait
```

## Fair vs Unfair Locks

```java
ReentrantLock fairLock = new ReentrantLock(true);   // FIFO ordering
ReentrantLock unfairLock = new ReentrantLock(false); // default: unfair
```

- **Unfair** (default): When the lock is released, any waiting thread can grab it — including one that just arrived. Higher throughput because threads can "barge in" without queue overhead.
- **Fair**: Threads acquire the lock in arrival order. Prevents starvation but reduces throughput (more overhead, less CPU cache reuse).

Use fair locks only when starvation is an actual concern. In most production code, unfair locks are the right choice.

## `Condition`: Multiple Wait Sets

With `synchronized`, there's one wait set per object. With `ReentrantLock`, you can create multiple `Condition` objects — each with its own wait set:

```java
ReentrantLock lock = new ReentrantLock();
Condition notFull  = lock.newCondition();
Condition notEmpty = lock.newCondition();
```

Rewrite our bounded queue from Part 3 using `Condition`:

```java
public class BoundedBlockingQueue<T> {
    private final ReentrantLock lock = new ReentrantLock();
    private final Condition notFull  = lock.newCondition();
    private final Condition notEmpty = lock.newCondition();
    private final Queue<T> queue = new LinkedList<>();
    private final int capacity;

    public BoundedBlockingQueue(int capacity) {
        this.capacity = capacity;
    }

    public void put(T item) throws InterruptedException {
        lock.lock();
        try {
            while (queue.size() == capacity) {
                notFull.await();  // wait on "not full" condition
            }
            queue.add(item);
            notEmpty.signal();  // signal a single consumer
        } finally {
            lock.unlock();
        }
    }

    public T take() throws InterruptedException {
        lock.lock();
        try {
            while (queue.isEmpty()) {
                notEmpty.await();  // wait on "not empty" condition
            }
            T item = queue.poll();
            notFull.signal();  // signal a single producer
            return item;
        } finally {
            lock.unlock();
        }
    }
}
```

With `synchronized` + `notifyAll()`, every `put` wakes both producers and consumers. With `Condition`, `notFull.signal()` wakes only a producer, and `notEmpty.signal()` wakes only a consumer. Less wasted wakeup work.

## `ReadWriteLock`: Readers and Writers

Many data structures are read far more than written. `ReadWriteLock` allows concurrent reads while ensuring exclusive writes:

```java
ReadWriteLock rwLock = new ReentrantReadWriteLock();
Lock readLock  = rwLock.readLock();
Lock writeLock = rwLock.writeLock();

// Multiple threads can hold readLock simultaneously
readLock.lock();
try {
    return cache.get(key);
} finally {
    readLock.unlock();
}

// Only one thread can hold writeLock; no readers allowed while writing
writeLock.lock();
try {
    cache.put(key, value);
} finally {
    writeLock.unlock();
}
```

Rules:
- Multiple threads can hold the **read lock** simultaneously (as long as no write lock is held)
- Only one thread can hold the **write lock** (exclusive)
- A write lock blocks all readers

## `StampedLock`: Optimistic Reads

`StampedLock` (Java 8) adds an optimistic read mode — useful when reads greatly outnumber writes and conflicts are rare:

```java
StampedLock sl = new StampedLock();

// Optimistic read: doesn't acquire a lock, just reads a stamp
long stamp = sl.tryOptimisticRead();
int x = point.x;
int y = point.y;

if (!sl.validate(stamp)) {
    // A write happened during our read — fall back to a real read lock
    stamp = sl.readLock();
    try {
        x = point.x;
        y = point.y;
    } finally {
        sl.unlockRead(stamp);
    }
}
```

If no write occurred between `tryOptimisticRead()` and `validate()`, you read the data with **zero lock overhead**. Only on conflict do you retry with a proper read lock.

Let's benchmark all three approaches for a read-heavy cache (95% reads, 5% writes):

```java
@State(Scope.Benchmark)
public class LockBenchmark {
    private final ReentrantLock lock = new ReentrantLock();
    private final ReentrantReadWriteLock rwLock = new ReentrantReadWriteLock();
    private final StampedLock sl = new StampedLock();
    private int value = 0;

    @Benchmark
    @Threads(16)
    public int reentrantRead() {
        lock.lock();
        try { return value; } finally { lock.unlock(); }
    }

    @Benchmark
    @Threads(16)
    public int rwLockRead() {
        rwLock.readLock().lock();
        try { return value; } finally { rwLock.readLock().unlock(); }
    }

    @Benchmark
    @Threads(16)
    public int stampedOptimistic() {
        long stamp = sl.tryOptimisticRead();
        int v = value;
        if (!sl.validate(stamp)) {
            stamp = sl.readLock();
            try { v = value; } finally { sl.unlockRead(stamp); }
        }
        return v;
    }
}
```

Typical results (16 reader threads, read-only):

```
Benchmark                       Mode  Cnt     Score     Error  Units
LockBenchmark.reentrantRead    thrpt   25  12,341.2 ±  234.1  ops/ms
LockBenchmark.rwLockRead       thrpt   25  89,432.5 ±  891.4  ops/ms
LockBenchmark.stampedOptimistic thrpt   25 243,891.7 ± 1234.2  ops/ms
```

`StampedLock` optimistic reads are ~20x faster than `ReentrantLock` under pure read contention.

**StampedLock caveats:**
- Not reentrant — don't call it recursively
- No `Condition` support
- Complex API; easy to misuse
- Lock upgrade (read → write) is not supported directly

## `LockSupport`: The Foundation

All of `java.util.concurrent.locks` is built on `LockSupport`:

```java
LockSupport.park();          // suspend current thread
LockSupport.unpark(thread);  // resume a specific thread
```

Unlike `wait/notify`, `unpark` can be called before `park` — the "permit" is stored. This avoids missed wakeup bugs that are possible with `wait/notify`.

You rarely use `LockSupport` directly, but understanding it explains what happens in `jstack`:

```
"my-thread" #23 prio=5 os_prio=0 tid=0x... nid=0x... waiting on condition
   java.lang.Thread.State: WAITING (parking)
        at sun.misc.Unsafe.park(Native Method)
        - parking to wait for <0x...> (a java.util.concurrent.locks.AbstractQueuedSynchronizer$ConditionObject)
        at java.util.concurrent.locks.LockSupport.park(LockSupport.java:...)
        at java.util.concurrent.locks.AbstractQueuedSynchronizer...
```

`WAITING (parking)` = the thread called `LockSupport.park()`. This is how `ReentrantLock`, `Semaphore`, `CountDownLatch`, and most of `j.u.c` work internally.

## `AbstractQueuedSynchronizer` (AQS)

All the locks in `java.util.concurrent.locks` are built on `AbstractQueuedSynchronizer` (AQS). AQS manages:

- An **atomic state integer** (the lock count, permits, etc.)
- A **CLH queue** of parked threads waiting to acquire

You won't interact with AQS directly, but knowing it exists explains why `ReentrantLock`, `Semaphore`, `CountDownLatch`, and `CyclicBarrier` all have the same general shape.

## When to Choose What

| Use case | Tool |
|----------|------|
| Simple mutual exclusion | `synchronized` — simpler, JIT-optimized |
| Timed or interruptible lock | `ReentrantLock` |
| Multiple condition queues | `ReentrantLock` + `Condition` |
| Read-heavy, write-occasional | `ReentrantReadWriteLock` |
| Very read-heavy, low contention | `StampedLock` optimistic read |
| You need `lock().lockInterruptibly()` semantics | `ReentrantLock` |

## Troubleshooting: Live-Lock and Starvation

Live-lock: threads keep retrying but no one makes progress.

```java
// Anti-pattern: immediate retry without backoff
while (!lock.tryLock()) {
    // spin — can cause live-lock under high contention
}
```

Fix: add random backoff:

```java
Random rand = new Random();
while (!lock.tryLock(rand.nextInt(10), TimeUnit.MILLISECONDS)) {
    // retry with jitter
}
```

Starvation with unfair lock: one thread keeps grabbing the lock before others get a chance. Diagnose with JFR's "Java Monitor Wait" event, or switch to `new ReentrantLock(true)` to enable fairness.

## Summary

| Concept | Key Point |
|---------|-----------|
| `ReentrantLock` | More flexible than `synchronized`; requires explicit unlock |
| `tryLock()` | Non-blocking; use for deadlock avoidance |
| `Condition` | Multiple wait sets on one lock |
| `ReadWriteLock` | Concurrent reads, exclusive writes |
| `StampedLock` | Optimistic reads for read-heavy workloads |
| `LockSupport` | The primitive beneath all `j.u.c` locks |
| AQS | Shared framework for all `j.u.c` synchronizers |

**Next:** In Part 5, we'll go even lower — to atomic operations. CAS (compare-and-swap) is a CPU instruction that lets you update shared state without any lock at all. `AtomicInteger`, `LongAdder`, and `VarHandle` all build on it.

---

**Part 4 complete. Next: [Atomic Operations & Lock-Free Programming](/blog/java-concurrency-series-5-atomics/)**
