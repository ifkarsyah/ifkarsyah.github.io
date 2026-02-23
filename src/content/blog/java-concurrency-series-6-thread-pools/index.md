---
title: "Java Concurrency Series, Part 6: Thread Pools & Executors"
description: "Why does tuning your thread pool size matter? Understand ThreadPoolExecutor internals, queue types, rejection policies, ForkJoinPool work-stealing, and CompletableFuture async pipelines."
pubDate: 2026-04-06
author: "ifkarsyah"
domain: "Backend"
stack: ["Java"]
image:
  src: ./java-concurrency-series.png
  alt: "Java Concurrency Internals"
---

In Part 1, we saw that creating a thread costs ~30 µs and ~512KB of stack. For a service handling thousands of requests per second, creating a new thread per request is wasteful and will eventually fail with `OutOfMemoryError: unable to create native thread`.

Thread pools solve this: create a fixed set of worker threads upfront, reuse them across tasks, and queue tasks when all workers are busy. But getting the pool configuration wrong causes failures that are subtle and production-only.

**Key question:** Why does tuning your thread pool size matter so much?

## `ThreadPoolExecutor` Internals

All thread pools in Java are ultimately `ThreadPoolExecutor` instances. Its internal behavior follows these rules:

```
Task submitted:
  1. If workers < corePoolSize       → create new worker thread
  2. Else if queue is not full       → enqueue the task
  3. Else if workers < maxPoolSize   → create new (extra) worker thread
  4. Else                            → apply rejection policy
```

```
┌─────────────────────────────────────────────────────┐
│ ThreadPoolExecutor                                  │
│                                                     │
│  corePoolSize: 4    maxPoolSize: 8                  │
│                                                     │
│  Workers: [W1][W2][W3][W4]  (core workers, always)  │
│                                                     │
│  Work Queue: [T5][T6][T7][T8][T9]                   │
│                                                     │
│  Extra workers: [W5][W6]  (created on queue full)   │
└─────────────────────────────────────────────────────┘
```

The extra workers (above `corePoolSize`) are idle-timed-out and removed after `keepAliveTime` elapses.

## Creating a `ThreadPoolExecutor`

```java
ThreadPoolExecutor pool = new ThreadPoolExecutor(
    4,                              // corePoolSize
    8,                              // maximumPoolSize
    60, TimeUnit.SECONDS,           // keepAliveTime for extra threads
    new ArrayBlockingQueue<>(100),  // work queue (bounded!)
    new ThreadFactory() { /* ... */ },
    new ThreadPoolExecutor.CallerRunsPolicy() // rejection policy
);
```

### The Convenience Factory Methods

```java
// Fixed pool: corePoolSize = maxPoolSize, unbounded queue
Executors.newFixedThreadPool(8);

// Single thread: ordered execution, unbounded queue
Executors.newSingleThreadExecutor();

// Cached: 0 core, Integer.MAX_VALUE max, 60s keepalive, SynchronousQueue
Executors.newCachedThreadPool();

// Scheduled: for delayed/periodic tasks
Executors.newScheduledThreadPool(4);
```

**Warning:** `Executors.newFixedThreadPool` and `newSingleThreadExecutor` use an **unbounded** `LinkedBlockingQueue`. If producers are faster than consumers, the queue grows without bound → `OutOfMemoryError`. Always use a bounded queue in production.

## Queue Types: The Critical Choice

| Queue | Behavior | Use When |
|-------|----------|----------|
| `LinkedBlockingQueue` (unbounded) | Never rejects; queue grows to OOM | Never (production) |
| `ArrayBlockingQueue(n)` | Bounded; blocks or rejects at `n` | Most services |
| `SynchronousQueue` | No storage; handoff only | `newCachedThreadPool` — every task must be immediately taken |
| `PriorityBlockingQueue` | Ordered by priority | Task scheduling systems |

For a production HTTP server handling requests:

```java
ThreadPoolExecutor pool = new ThreadPoolExecutor(
    Runtime.getRuntime().availableProcessors(),      // core
    Runtime.getRuntime().availableProcessors() * 2,  // max
    60, TimeUnit.SECONDS,
    new ArrayBlockingQueue<>(500),                   // bounded: ~500ms of buffering
    r -> {
        Thread t = new Thread(r, "http-worker-" + counter.getAndIncrement());
        t.setDaemon(true);
        return t;
    },
    new ThreadPoolExecutor.AbortPolicy()  // throw RejectedExecutionException → 503
);
```

## Rejection Policies

When the queue is full and maxPoolSize is reached:

| Policy | Behavior |
|--------|----------|
| `AbortPolicy` (default) | Throw `RejectedExecutionException` |
| `CallerRunsPolicy` | Submitting thread runs the task itself (backpressure) |
| `DiscardPolicy` | Silently drop the task |
| `DiscardOldestPolicy` | Drop the oldest queued task, retry submission |

`CallerRunsPolicy` is elegant — if the pool is saturated, the HTTP handler thread runs the task directly, which slows down incoming request acceptance and creates natural backpressure.

## Monitoring Pool State

```java
ThreadPoolExecutor pool = /* ... */;

// Log pool state every 10 seconds
ScheduledExecutorService monitor = Executors.newSingleThreadScheduledExecutor();
monitor.scheduleAtFixedRate(() -> {
    System.out.printf(
        "pool: active=%d, queued=%d, completed=%d, pool_size=%d%n",
        pool.getActiveCount(),
        pool.getQueue().size(),
        pool.getCompletedTaskCount(),
        pool.getPoolSize()
    );
}, 0, 10, TimeUnit.SECONDS);
```

Key metrics to alert on:
- `getQueue().size()` approaching capacity → pool is saturated
- `getRejectedExecutionCount()` > 0 → tasks are being dropped
- `getActiveCount() == getMaximumPoolSize()` → fully saturated

## Thread Pool Sizing: CPU-Bound vs I/O-Bound

The classic formula (Brian Goetz, "Java Concurrency in Practice"):

```
For CPU-bound tasks:
  poolSize = N_cpus + 1

For I/O-bound tasks:
  poolSize = N_cpus × (1 + W/C)
  where W = wait time (I/O), C = compute time
```

**CPU-bound example** (image resizing, encryption):

```java
int cpus = Runtime.getRuntime().availableProcessors();
ExecutorService cpuPool = Executors.newFixedThreadPool(cpus + 1);
```

Adding 1 covers occasional I/O waits or GC pauses, ensuring CPUs stay busy.

**I/O-bound example** (database queries taking ~50ms, compute ~5ms each):

```
W/C = 50/5 = 10
poolSize = 8 × (1 + 10) = 88
```

For a database-heavy service on an 8-core machine, ~88 threads keeps all CPUs busy while threads wait for DB responses.

Verify experimentally with JMH or load testing — these formulas are starting points.

## `ForkJoinPool` and Work-Stealing

`ForkJoinPool` is designed for recursive, divide-and-conquer tasks. Each worker thread has its own **deque** (double-ended queue):

```
┌──────────────────────────────────────────────────────┐
│ ForkJoinPool                                         │
│                                                      │
│  Worker 1: [T1, T2, T3]  (own work, push/pop left)   │
│  Worker 2: [T4, T5]      (steal from right of others)│
│  Worker 3: []             (idle → steal from Worker 1)│
│  Worker 4: [T6]                                      │
└──────────────────────────────────────────────────────┘
```

Work-stealing: idle workers steal tasks from the tail (right) of other workers' deques, while owners push/pop from the head (left). Minimal contention because only the tail is accessed by thieves.

```java
ForkJoinPool pool = new ForkJoinPool(
    Runtime.getRuntime().availableProcessors(),
    ForkJoinPool.defaultForkJoinWorkerThreadFactory,
    null,   // uncaught exception handler
    true    // asyncMode: FIFO for tasks (use for event-driven)
);

// Recursive sum of array using fork/join
class SumTask extends RecursiveTask<Long> {
    private final int[] array;
    private final int from, to;
    static final int THRESHOLD = 1000;

    SumTask(int[] array, int from, int to) {
        this.array = array; this.from = from; this.to = to;
    }

    @Override
    protected Long compute() {
        if (to - from <= THRESHOLD) {
            long sum = 0;
            for (int i = from; i < to; i++) sum += array[i];
            return sum;
        }
        int mid = (from + to) / 2;
        SumTask left = new SumTask(array, from, mid);
        SumTask right = new SumTask(array, mid, to);
        left.fork();           // async: schedule left
        long rightResult = right.compute();  // run right in current thread
        return left.join() + rightResult;    // wait for left
    }
}

int[] data = new int[10_000_000];
// ... fill data ...
long result = pool.invoke(new SumTask(data, 0, data.length));
```

The common pool (`ForkJoinPool.commonPool()`) is used by parallel streams and `CompletableFuture` by default:

```java
// This uses commonPool internally:
List<String> results = list.parallelStream()
    .map(this::processItem)
    .collect(Collectors.toList());
```

The common pool size defaults to `N_cpus - 1`. Blocking tasks in the common pool (DB calls, HTTP requests) will starve all parallel streams. Use a dedicated pool for I/O-bound tasks.

## `CompletableFuture`: Async Pipelines

`CompletableFuture` lets you compose async operations without blocking:

```java
CompletableFuture<UserProfile> profile = CompletableFuture
    .supplyAsync(() -> db.findUser(userId), ioPool)        // fetch user
    .thenApplyAsync(user -> enrichment.enrich(user), ioPool) // call enrichment API
    .thenApply(profile -> profile.withDefaults());           // sync transform

// Combine two futures
CompletableFuture<String> name = CompletableFuture.supplyAsync(() -> fetchName());
CompletableFuture<Integer> age  = CompletableFuture.supplyAsync(() -> fetchAge());

CompletableFuture<String> result = name.thenCombine(age,
    (n, a) -> n + " (age " + a + ")"
);
```

Error handling:

```java
CompletableFuture<Data> future = fetchData()
    .exceptionally(ex -> {
        log.warn("Fetch failed: " + ex.getMessage());
        return Data.empty();  // fallback value
    })
    .thenApply(data -> transform(data));
```

Fan-out / fan-in:

```java
List<CompletableFuture<Result>> futures = ids.stream()
    .map(id -> CompletableFuture.supplyAsync(() -> fetch(id), ioPool))
    .collect(Collectors.toList());

// Wait for all
CompletableFuture.allOf(futures.toArray(new CompletableFuture[0]))
    .thenRun(() -> System.out.println("All done"));

// Get results
List<Result> results = futures.stream()
    .map(CompletableFuture::join)
    .collect(Collectors.toList());
```

## Troubleshooting: Thread Pool Saturation

Symptoms:
- Latency spikes (requests queued waiting for a worker)
- `RejectedExecutionException` in logs
- `getQueue().size()` near capacity

Diagnose with a thread dump:

```bash
jstack <pid> | grep "http-worker"
```

If all threads show database/network calls in their stack, your pool is too small for your I/O wait time — increase the pool size or reduce I/O time.

If threads are mostly idle but requests are slow, look elsewhere (GC pauses, downstream latency).

## Graceful Shutdown

```java
pool.shutdown();                              // stop accepting new tasks
pool.awaitTermination(30, TimeUnit.SECONDS);  // wait for in-flight tasks
if (!pool.isTerminated()) {
    pool.shutdownNow();                       // interrupt workers
}
```

`shutdownNow()` calls `interrupt()` on all worker threads. Tasks must check `Thread.currentThread().isInterrupted()` or use interruptible blocking calls to respond.

## Summary

| Concept | Key Point |
|---------|-----------|
| `ThreadPoolExecutor` flow | core → queue → max → reject |
| Bounded queue | Always use `ArrayBlockingQueue(n)` in production |
| `CallerRunsPolicy` | Natural backpressure: submitter runs the task |
| CPU-bound sizing | `N_cpus + 1` |
| I/O-bound sizing | `N_cpus × (1 + W/C)` |
| `ForkJoinPool` | Work-stealing; best for recursive divide-and-conquer |
| `CompletableFuture` | Async composition without blocking |

**Next:** In Part 7, we'll look at concurrent collections. `ConcurrentHashMap` is not just a `synchronized HashMap` — it uses completely different internal locking to achieve dramatically higher throughput.

---

**Part 6 complete. Next: [Concurrent Collections](/blog/java-concurrency-series-7-concurrent-collections/)**
