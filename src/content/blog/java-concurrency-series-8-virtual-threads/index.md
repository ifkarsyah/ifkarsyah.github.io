---
title: "Java Concurrency Series, Part 8: Virtual Threads & Project Loom"
description: "What changes when threads become cheap? Understand carrier threads, continuations, pinning, StructuredTaskScope, and how virtual threads flip the economics of I/O-bound Java services."
pubDate: 2026-04-20
author: "ifkarsyah"
domain: "Backend"
stack: ["Java"]
image:
  src: ./java-concurrency-series.png
  alt: "Java Concurrency Internals"
---

In Part 1, we established that platform threads are expensive: ~30 µs to create and ~512KB of stack. For a service with 10,000 concurrent requests, that's 5 GB of stack memory and prohibitive creation overhead. This is why we use thread pools (Part 6) — reusing threads rather than creating new ones.

Java 21 (JEP 444) changes the economics entirely. Virtual threads are cheap: millions can coexist, creation costs ~1 µs, and they consume kilobytes of heap — not megabytes of native stack. A blocking call in a virtual thread doesn't block an OS thread.

**Key question:** What changes when threads become cheap?

## Virtual Thread Architecture

In the platform thread model (Part 1):

```
Virtual Thread ←── NOT THIS
Platform Thread (JVM) ──── OS Thread (1:1)
```

Virtual threads introduce a new layer:

```
Virtual Thread (JVM-managed, millions)
         │
    mounts onto
         │
Carrier Thread (platform thread, small pool)
         │
      is an
         │
OS Kernel Thread (1:1 with carrier)
```

- **Carrier threads**: a small `ForkJoinPool` (default size: `N_cpus`) that runs virtual threads
- **Virtual threads**: JVM-managed, backed by continuations (stackful coroutines)
- **Mounting/unmounting**: when a virtual thread blocks (I/O, sleep, lock), it **unmounts** from its carrier — the carrier is freed to run another virtual thread

## Creating Virtual Threads

```java
// Direct creation
Thread vt = Thread.ofVirtual().name("my-vt").start(() -> {
    System.out.println("Hello from virtual thread");
});

// Via factory
ThreadFactory factory = Thread.ofVirtual().name("worker-", 0).factory();

// Via executor (simplest for pools)
ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
executor.submit(() -> handleRequest(request));  // one virtual thread per task
```

With `newVirtualThreadPerTaskExecutor()`, you submit one task per virtual thread — no pool sizing, no queue tuning. The JVM manages the carrier pool automatically.

## What Happens on a Blocking Call

```java
// In a virtual thread:
InputStream in = socket.getInputStream();
byte[] buf = new byte[1024];
in.read(buf);  // I/O operation — blocks
```

Sequence:

1. Virtual thread calls `read()`
2. JVM detects the blocking operation
3. Virtual thread **unmounts** from carrier — its continuation (stack state) is saved to heap
4. Carrier thread is freed — picks up another virtual thread
5. When I/O completes, virtual thread is **remounted** — on any available carrier
6. Execution resumes after `read()`

```
Carrier C1:   [VT-1 running] → [VT-2 running] → [VT-1 resumed]
                    VT-1 blocked (I/O)  VT-1 I/O done

Stack state for VT-1 is saved to heap during the block.
```

This is why `BlockingQueue.take()`, `Thread.sleep()`, JDBC calls, HTTP requests — all of them work correctly in virtual threads without blocking a carrier.

## Benchmark: Platform Threads vs Virtual Threads

A service that simulates 1,000 concurrent I/O-bound tasks (50ms sleep = network call):

```java
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.MILLISECONDS)
@State(Scope.Thread)
public class VirtualThreadBenchmark {

    static final int TASKS = 1_000;
    static final int SLEEP_MS = 50;

    @Benchmark
    public void platformThreadPool() throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(200); // typical pool
        List<Future<?>> futures = new ArrayList<>();
        for (int i = 0; i < TASKS; i++) {
            futures.add(pool.submit(() -> {
                Thread.sleep(SLEEP_MS);
                return null;
            }));
        }
        for (Future<?> f : futures) f.get();
        pool.shutdown();
    }

    @Benchmark
    public void virtualThreads() throws Exception {
        ExecutorService executor = Executors.newVirtualThreadPerTaskExecutor();
        List<Future<?>> futures = new ArrayList<>();
        for (int i = 0; i < TASKS; i++) {
            futures.add(executor.submit(() -> {
                Thread.sleep(SLEEP_MS);
                return null;
            }));
        }
        for (Future<?> f : futures) f.get();
        executor.shutdown();
    }
}
```

Results:

```
Benchmark                              Mode  Cnt    Score   Error  Units
VirtualThreadBenchmark.platformThreadPool  avt   10  254.3 ± 12.1  ms
VirtualThreadBenchmark.virtualThreads      avt   10   52.4 ±  1.8  ms
```

Platform thread pool (200 threads): 1,000 tasks × 50ms / 200 threads = ~250ms (5 batches).

Virtual threads: all 1,000 run "concurrently" on ~8 carrier threads, all sleeping at once. Wall time ≈ one sleep = ~52ms.

## `StructuredTaskScope`: Structured Concurrency

Virtual threads are paired with **structured concurrency** (Java 21 preview, stabilized in 23): task lifetimes are scoped to a block, like `try-with-resources`.

```java
try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
    Subtask<User>    userTask    = scope.fork(() -> fetchUser(userId));
    Subtask<Account> accountTask = scope.fork(() -> fetchAccount(userId));

    scope.join();           // wait for both
    scope.throwIfFailed();  // propagate exceptions

    return new Profile(userTask.get(), accountTask.get());
}
```

`ShutdownOnFailure`: if any subtask fails, cancel the others immediately.

`ShutdownOnSuccess`: return the first successful result, cancel the rest:

```java
try (var scope = new StructuredTaskScope.ShutdownOnSuccess<String>()) {
    scope.fork(() -> fetchFromPrimary());
    scope.fork(() -> fetchFromReplica());

    scope.join();
    return scope.result();  // whichever returned first
}
```

No manual `Future.cancel()`. No leaked tasks. The scope guarantees all subtasks are done (or cancelled) before the block exits.

## Scoped Values: Replacing `ThreadLocal`

`ThreadLocal` breaks with virtual threads — not technically, but ergonomically. A virtual thread inheriting `ThreadLocal` values from a parent and sharing them with child tasks is tricky.

**Scoped values** (Java 21 preview) are the modern replacement:

```java
static final ScopedValue<User> CURRENT_USER = ScopedValue.newInstance();

// Bind the value for a scope
ScopedValue.where(CURRENT_USER, user).run(() -> {
    processRequest();  // CURRENT_USER is accessible here
});

// Read from anywhere within the scope
void processRequest() {
    User user = CURRENT_USER.get();  // always accessible within the scope
}
```

Properties:
- **Immutable within scope** — can't be changed after binding (unlike `ThreadLocal.set()`)
- **Inherited by child virtual threads** — automatically
- **Bounded lifetime** — gone when the scope exits

## Pinning: The One Thing That Breaks Virtual Threads

Virtual threads unmount on blocking operations — unless they're **pinned** to their carrier. Pinned threads cannot unmount, and their carrier is held for the duration.

Two causes of pinning:

### 1. `synchronized` blocks with blocking I/O inside

```java
// This PINS the carrier — don't do this with virtual threads
synchronized (lock) {
    result = jdbcStatement.executeQuery();  // blocks while pinned!
}
```

The carrier is blocked waiting for the DB query. No other virtual thread can use it.

**Fix:** Replace `synchronized` with `ReentrantLock` (Part 4):

```java
lock.lock();
try {
    result = jdbcStatement.executeQuery();  // virtual thread unmounts while waiting
} finally {
    lock.unlock();
}
```

### 2. Native frames in the call stack

If a virtual thread is inside a native method when it tries to block, it cannot unmount. JNI calls pin.

**Detect pinning:**

```bash
java -Djdk.tracePinnedThreads=full MyApp
```

Output when pinned:

```
Thread[#27,ForkJoinPool-1-worker-1,5,CarrierThreads]
    com.example.SlowLock.compute(SlowLock.java:42)
    <-- synchronized
```

Or use JFR:

```bash
jcmd <pid> JFR.start name=pinning settings=profile duration=30s filename=pinning.jfr
```

Look for the `jdk.VirtualThreadPinned` event.

## What to Migrate and What Not to

### Good candidates for virtual threads

- **HTTP servers** handling many concurrent requests (one virtual thread per request)
- **gRPC/REST clients** making many concurrent outbound calls
- **Database connection pools** — virtual threads block on JDBC, unmounting cleanly with `ReentrantLock`-based pools (HikariCP works well)
- **Message queue consumers** — blocking `poll()` on Kafka or similar

### Poor candidates

- **CPU-bound tasks** — virtual threads don't make computation faster; carrier threads still do the work. Use `ForkJoinPool` for parallelism.
- **Code with heavy `synchronized` + I/O** — pinning will negate benefits until you migrate to `ReentrantLock`
- **Work that uses `ThreadLocal` for mutable per-task state** — migrate to `ScopedValue` first

## Migration Guide: Thread Pool → Virtual Threads

Before:

```java
ExecutorService pool = Executors.newFixedThreadPool(200);
// ...
pool.submit(() -> handleRequest(request));
```

After:

```java
ExecutorService pool = Executors.newVirtualThreadPerTaskExecutor();
// ...
pool.submit(() -> handleRequest(request));
// No pool sizing needed — one virtual thread per task
```

That's often the entire migration. The big work is:
1. Auditing `synchronized` blocks that contain I/O — replace with `ReentrantLock`
2. Auditing `ThreadLocal` usage for mutable state — migrate to `ScopedValue` or explicit parameters
3. Checking library dependencies for pinning issues (JVM-level, not your code)

## Virtual Thread Memory Model

Virtual threads follow the same JMM rules as platform threads. `volatile`, `synchronized`, `ReentrantLock` — all have the same semantics. The JMM doesn't change.

What changes:
- Creating millions of virtual threads doesn't exhaust native memory
- Blocking on I/O doesn't block OS threads
- No need to tune pool size for I/O-bound concurrency

What doesn't change:
- Data races still exist — use the same synchronization primitives
- Atomicity requirements are the same
- Lock-free vs lock trade-offs are the same

## Observing Virtual Threads

```java
// List all virtual threads in a thread dump
jcmd <pid> Thread.print

# You'll see entries like:
# #31 "" virtual
#    java.lang.Thread.State: WAITING (parking)
#    at java.lang.VirtualThread.park(VirtualThread.java:...)
```

Or with JFR — `jdk.VirtualThreadStart`, `jdk.VirtualThreadEnd`, `jdk.VirtualThreadPinned` events give full lifecycle visibility.

## Summary

| Concept | Key Point |
|---------|-----------|
| Virtual thread | JVM-managed; mounts/unmounts on carrier threads |
| Carrier pool | Small `ForkJoinPool` (~N_cpus); shared by all virtual threads |
| Blocking I/O | Unmounts virtual thread; carrier is freed |
| Pinning | `synchronized` + I/O holds the carrier; replace with `ReentrantLock` |
| `StructuredTaskScope` | Scoped lifetime for concurrent subtasks |
| `ScopedValue` | Immutable, inherited alternative to `ThreadLocal` |
| Migration | Replace fixed pools with `newVirtualThreadPerTaskExecutor`; audit `synchronized` blocks |

---

## Series Complete

You've now traced the full spectrum of Java concurrency — from the CPU cache coherence model that motivates `volatile`, through the JVM's lock inflation machinery in `synchronized`, up to virtual threads that make millions of concurrent I/O operations practical.

The key insight: every tool in this series exists because the one below it has a limitation. `volatile` doesn't give atomicity → use `synchronized`. `synchronized` serializes all access → use `ReadWriteLock` or `StampedLock`. Locks have overhead → use atomics. Threads are expensive → use thread pools. Thread pools have sizing constraints → use virtual threads.

Understanding the whole stack means you can pick the right tool — and know when to switch.

**Start of series: [Overview — Why Concurrent Java Is Hard](/blog/java-concurrency-series-0-overview/)**
