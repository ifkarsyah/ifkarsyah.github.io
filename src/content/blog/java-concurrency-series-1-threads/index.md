---
title: "Java Concurrency Series, Part 1: Threads, the OS, and the JVM"
description: "What really happens when you call new Thread().start()? Trace the path from Java to the OS kernel, understand thread lifecycle states, and use jstack to observe live threads."
pubDate: 2026-03-02
author: "ifkarsyah"
domain: "Backend"
stack: ["Java"]
image:
  src: ./java-concurrency-series.png
  alt: "Java Concurrency Internals"
---

Every Java developer has written `new Thread(() -> ...).start()`. But what does `.start()` actually do? It doesn't just "run the lambda." It asks the JVM to ask the OS to create a kernel thread, allocate a stack, register it with the scheduler, and only then begin executing your code. This whole path has real costs — costs that matter when you're deciding whether to spawn threads or reuse them.

**Key question:** What is the real cost of creating and switching between threads?

## What Is a Thread?

A thread is the unit of execution in a program. Multiple threads share the same heap (objects, static fields) but each has its own:

- **Program counter** — which instruction to execute next
- **Stack** — local variables, method call frames
- **Thread-local storage** — `ThreadLocal<T>` values

In Java, a "platform thread" maps 1:1 to an OS kernel thread. The JVM doesn't do its own scheduling for platform threads — it delegates entirely to the OS.

```
┌──────────────────────────────────────┐
│ JVM Process                          │
│                                      │
│  Thread A  Thread B  Thread C        │
│  (stack)   (stack)   (stack)         │
│                                      │
│  ┌──────── Shared Heap ───────────┐  │
│  │  Objects, static fields, etc.  │  │
│  └────────────────────────────────┘  │
└────────┬──────────┬──────────┬───────┘
         │          │          │   (1:1 mapping)
    OS Thread  OS Thread  OS Thread
         │          │          │
         └──────────┴──────────┘
                 CPU Scheduler
```

## Thread Lifecycle

A Java thread goes through these states (defined in `Thread.State`):

```
NEW ──► RUNNABLE ──► BLOCKED
                 ──► WAITING
                 ──► TIMED_WAITING
                 ──► TERMINATED
```

| State | Meaning |
|-------|---------|
| `NEW` | Created with `new Thread(...)`, not yet started |
| `RUNNABLE` | Running or ready to run (on the CPU or in the run queue) |
| `BLOCKED` | Waiting to acquire a `synchronized` monitor |
| `WAITING` | Parked indefinitely — `wait()`, `join()`, `LockSupport.park()` |
| `TIMED_WAITING` | Parked with a timeout — `sleep(n)`, `wait(n)`, `park(nanos)` |
| `TERMINATED` | Finished execution |

Note: `RUNNABLE` includes both "currently executing on CPU" and "ready but waiting for CPU time." There's no separate `RUNNING` state in Java — the JVM can't distinguish these.

## Creating a Thread: What Actually Happens

```java
Thread t = new Thread(() -> {
    System.out.println("Hello from " + Thread.currentThread().getName());
});
t.start();
```

The call chain under `t.start()`:

1. `Thread.start()` (Java) calls native `start0()`
2. The JVM calls `pthread_create()` (Linux) or `CreateThread()` (Windows)
3. The OS allocates a kernel thread with a default stack (usually 512KB–1MB)
4. The OS scheduler adds it to the run queue
5. Eventually, the thread gets a CPU slot and your lambda runs

The creation itself takes **~10–50 µs** depending on OS and load. That's not free.

## Observing Live Threads with `jstack`

Let's create some threads in different states and observe them.

```java
public class ThreadStates {
    public static void main(String[] args) throws Exception {
        Object lock = new Object();

        // Thread in WAITING state
        Thread waiting = new Thread(() -> {
            synchronized (lock) {
                try { lock.wait(); } catch (InterruptedException e) {}
            }
        }, "demo-waiting");

        // Thread in TIMED_WAITING state
        Thread sleeping = new Thread(() -> {
            try { Thread.sleep(60_000); } catch (InterruptedException e) {}
        }, "demo-sleeping");

        // Thread trying to acquire a held lock -> BLOCKED
        Thread blocker = new Thread(() -> {
            synchronized (lock) { /* holds forever */ }
        }, "demo-holder");

        Thread blocked = new Thread(() -> {
            synchronized (lock) { /* will block */ }
        }, "demo-blocked");

        waiting.start();
        sleeping.start();
        blocker.start();
        Thread.sleep(100);
        blocked.start();

        System.out.println("PID: " + ProcessHandle.current().pid());
        Thread.sleep(60_000); // keep alive for inspection
    }
}
```

Run it, then in another terminal:

```bash
jstack <pid>
```

You'll see something like:

```
"demo-waiting" #21 prio=5 os_prio=0 tid=0x... nid=0x... in Object.wait()
   java.lang.Thread.State: WAITING (on object monitor)
        at java.lang.Object.wait(Native Method)
        at ThreadStates.lambda$0(ThreadStates.java:9)
        - locked <0x...> (a java.lang.Object)

"demo-sleeping" #22 prio=5 os_prio=0 tid=0x... nid=0x... waiting on condition
   java.lang.Thread.State: TIMED_WAITING (sleeping)
        at java.lang.Thread.sleep(Native Method)
        at ThreadStates.lambda$1(ThreadStates.java:14)

"demo-blocked" #24 prio=5 os_prio=0 tid=0x... nid=0x... waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
        at ThreadStates.lambda$3(ThreadStates.java:21)
        - waiting to lock <0x...> (a java.lang.Object)
        - locked by "demo-holder" (id=...)
```

Three distinct states, three distinct causes. `BLOCKED` is specifically `synchronized` contention. `WAITING` is an explicit wait. `TIMED_WAITING` is a sleep.

## Using `jcmd` for a More Detailed Thread Dump

`jcmd` is more versatile than `jstack`:

```bash
jcmd <pid> Thread.print        # same as jstack
jcmd <pid> VM.native_memory    # native memory breakdown
jcmd <pid> GC.heap_info        # heap summary
```

To get thread counts:

```bash
jcmd <pid> Thread.print | grep "java.lang.Thread.State" | sort | uniq -c
```

Output:

```
      1 java.lang.Thread.State: BLOCKED (on object monitor)
      3 java.lang.Thread.State: RUNNABLE
      1 java.lang.Thread.State: TIMED_WAITING (sleeping)
      1 java.lang.Thread.State: WAITING (on object monitor)
```

## The Cost of Context Switching

When the OS switches from one thread to another, it:

1. Saves the current thread's registers and program counter
2. Flushes or invalidates CPU cache lines associated with that thread
3. Loads the next thread's registers
4. Jumps to the next thread's program counter

A single context switch costs roughly **1–10 µs**. Under heavy contention, you can have thousands per second per CPU core. This is the "thread-per-request" scalability wall that virtual threads solve (Part 8).

Let's benchmark thread creation cost with JMH:

```java
@BenchmarkMode(Mode.AverageTime)
@OutputTimeUnit(TimeUnit.MICROSECONDS)
@State(Scope.Thread)
public class ThreadCreationBenchmark {

    @Benchmark
    public void createAndJoin() throws InterruptedException {
        Thread t = new Thread(() -> {});
        t.start();
        t.join();
    }
}
```

Typical result on a modern machine:

```
Benchmark                             Mode  Cnt    Score   Error  Units
ThreadCreationBenchmark.createAndJoin  avt   25   28.341 ± 0.812  us/op
```

~28 µs per thread. For a service handling 10,000 req/s, that's 280ms of thread creation overhead per second — before any actual work runs.

## Stack Size and Memory

Each platform thread has a stack. The default is usually 512KB–1MB (JVM-dependent, platform-dependent). You can tune it:

```java
Thread t = new Thread(null, () -> { ... }, "my-thread", 256 * 1024); // 256KB stack
```

For 10,000 threads with 512KB stacks: **5 GB of stack memory**. This is the fundamental scalability problem that thread-per-request models hit.

Check current thread count and memory:

```bash
jcmd <pid> VM.native_memory summary
```

```
-  Thread (reserved=82961KB, committed=82961KB)
              (thread #81)
              (stack: reserved=82432KB, committed=82432KB)
```

81 threads × ~1MB each = ~82MB of native stack memory.

## Naming and Grouping Threads

Always name your threads. A thread dump with `thread-pool-1-thread-47` is far less useful than `payment-processor-47`.

```java
ThreadFactory factory = Thread.ofPlatform()
    .name("payment-processor-", 0)  // auto-increments: payment-processor-0, -1, ...
    .factory();

ExecutorService pool = Executors.newFixedThreadPool(10, factory);
```

Thread groups (legacy, rarely used) let you interrupt or enumerate threads by group. For modern code, use named threads with `ExecutorService`.

## Daemon vs. Non-Daemon Threads

```java
Thread t = new Thread(() -> { /* background work */ });
t.setDaemon(true);
t.start();
```

The JVM exits when all **non-daemon** threads finish. Daemon threads are killed when the JVM exits. Use daemon threads for background tasks (metrics, cache refresh) that shouldn't prevent shutdown.

## Interruption

Java's cooperative interruption model:

```java
Thread t = new Thread(() -> {
    while (!Thread.currentThread().isInterrupted()) {
        doWork();
    }
});

// From another thread:
t.interrupt();
```

Blocking calls (`sleep`, `wait`, `join`, `park`) throw `InterruptedException` when the thread is interrupted, and **clear the interrupt flag**. Always either re-interrupt or propagate:

```java
try {
    Thread.sleep(1000);
} catch (InterruptedException e) {
    Thread.currentThread().interrupt(); // restore the flag
    return;
}
```

## Troubleshooting: Thread Leaks

Thread leaks are common in servers. A leaked thread shows up in `jstack` as `WAITING` or `TIMED_WAITING` forever, usually holding a resource.

Signs of a thread leak:
- Thread count grows over time (`jcmd <pid> Thread.print | grep "State:" | wc -l`)
- Memory usage climbs (stack memory)
- Eventually: `OutOfMemoryError: unable to create native thread`

Common causes:
- Submitting tasks to `ExecutorService` without proper shutdown
- `BlockingQueue.take()` loops without interrupt checks
- Calling `Thread.join()` without timeout

Always shut down executor services:

```java
ExecutorService pool = Executors.newFixedThreadPool(8);
try {
    // submit tasks
} finally {
    pool.shutdown();
    pool.awaitTermination(30, TimeUnit.SECONDS);
}
```

## Summary

| Concept | Key Point |
|---------|-----------|
| Platform thread | 1:1 with OS kernel thread |
| Thread creation | ~10–50 µs, allocates ~512KB–1MB stack |
| Context switch | ~1–10 µs, CPU cache disruption |
| `BLOCKED` | Waiting for `synchronized` monitor |
| `WAITING` | Explicitly parked (`wait`, `join`, `park`) |
| `jstack` / `jcmd` | Essential tools for live thread inspection |
| Interruption | Cooperative; always restore the flag |

**Next:** In Part 2, we'll leave the OS behind and go deeper into the CPU — examining write buffers, cache coherence, and the Java Memory Model that governs what one thread can see when another writes.

---

**Part 1 complete. Next: [The Java Memory Model & Visibility](/blog/java-concurrency-series-2-memory-model/)**
