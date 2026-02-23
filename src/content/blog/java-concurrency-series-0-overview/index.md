---
title: "Java Concurrency Series, Part 0: Overview"
description: "A roadmap through Java concurrency — from threads and the memory model to virtual threads. Why getting concurrency right is hard, and what you'll learn."
pubDate: 2026-02-23
author: "ifkarsyah"
domain: "Backend"
stack: ["Java"]
image:
  src: ./java-concurrency-series.png
  alt: "Java Concurrency Internals"
---

Java has had concurrency support since version 1.0. And yet, concurrent bugs remain among the hardest to reproduce, diagnose, and fix. Race conditions show up only under load. Deadlocks appear only in production. Visibility bugs vanish when you add a `System.out.println` for debugging.

This series cuts through the confusion. Over 9 parts, we'll examine how Java concurrency actually works — from what the CPU does when two threads share memory, to how virtual threads in Java 21 change the game entirely.

**Why does this matter?**

- **Race conditions and visibility bugs** are invisible to the compiler. You need to understand the Java Memory Model to write correct concurrent code — not just hope it works
- **Performance bottlenecks** in multi-threaded code are often caused by lock contention or misconfigured thread pools, not slow algorithms
- **Modern Java** (21+) introduces virtual threads that change how you design I/O-bound services — but misusing them causes subtle pinning bugs
- **Debugging hung threads and deadlocks** requires knowing what `jstack` output means and what the JVM is actually doing

This series assumes you know Java basics and have written multi-threaded code before. You don't need to be a JVM engineer — we'll focus on observable behavior, runnable examples, and production implications.

## What We'll Cover

### Part 1: Threads, the OS, and the JVM
What actually happens when you call `new Thread().start()`? We'll trace the path from Java code to an OS kernel thread, examine thread lifecycle states, and use `jstack` and `jcmd` to observe live threads.

**Key question:** What is the real cost of creating and switching between threads?

### Part 2: The Java Memory Model & Visibility
The most underappreciated part of Java concurrency. CPUs have caches and write buffers. Compilers reorder instructions. The JMM defines what is and isn't guaranteed — and `volatile` is the simplest tool to enforce it.

**Key question:** Why can a running thread see stale data written by another thread?

### Part 3: `synchronized` & Intrinsic Locks
`synchronized` is simple to write but complex inside. Object headers carry lock state, and the JVM escalates from biased to thin to fat locks based on contention. We'll also cover `wait/notify` and diagnose deadlocks with `jstack`.

**Key question:** What does `synchronized` actually do at the JVM level?

### Part 4: `java.util.concurrent` Building Blocks
Java 5 introduced `java.util.concurrent` with `ReentrantLock`, `StampedLock`, and `Condition`. These give you capabilities `synchronized` can't: timed attempts, interruptible locks, and optimistic reads.

**Key question:** Why does `ReentrantLock` exist if `synchronized` already works?

### Part 5: Atomic Operations & Lock-Free Programming
Sometimes you don't need a lock at all. CAS (compare-and-swap) operations backed by CPU instructions let you update shared state atomically. `AtomicInteger`, `LongAdder`, and `VarHandle` all build on this.

**Key question:** How can you update shared state without any lock?

### Part 6: Thread Pools & Executors
Raw threads are expensive to create. `ThreadPoolExecutor` manages a pool of workers and a task queue. Tuning it wrong — too few threads, unbounded queues, wrong rejection policy — causes subtle production failures.

**Key question:** Why does tuning your thread pool size matter so much?

### Part 7: Concurrent Collections
`Collections.synchronizedMap(new HashMap<>())` is correct but slow. `ConcurrentHashMap` achieves much higher throughput through fine-grained locking. We'll also cover `BlockingQueue`, `CopyOnWriteArrayList`, and `ConcurrentSkipListMap`.

**Key question:** Why can't you just wrap a `HashMap` in `synchronized`?

### Part 8: Virtual Threads & Project Loom (Java 21)
Virtual threads are JVM-managed, not OS-managed. They're cheap to create (millions at once), and blocking operations yield the carrier thread automatically. This changes how you write I/O-bound services.

**Key question:** What changes when threads become cheap?

## How to Use This Series

Each article is **standalone** — you can read them out of order. But they're designed to build on each other, so sequential reading gives the best foundation.

**To follow along:**
- Install JDK 21 (virtual threads are stable from Java 21)
- Have `jdk.jconsole`, `jstack`, and `jcmd` available (they ship with the JDK)
- For benchmarks: add JMH as a dependency

```xml
<dependency>
  <groupId>org.openjdk.jmh</groupId>
  <artifactId>jmh-core</artifactId>
  <version>1.37</version>
</dependency>
```

**Code examples** are copy-paste ready. Run them yourself to observe the behavior — many concurrency bugs only reveal themselves at runtime.

## A Quick Architecture Overview

Here's how the layers we'll study relate to each other:

```
┌────────────────────────────────────────────────────────────┐
│ Your Java Code                                             │
│ (synchronized, Lock, Atomic*, CompletableFuture)           │
└───────────────────────────┬────────────────────────────────┘
                            │
              ┌─────────────▼─────────────┐
              │ JVM Runtime               │
              │ (JIT, object headers,     │
              │  lock inflation, GC)      │
              └─────────────┬─────────────┘
                            │
              ┌─────────────▼─────────────┐
              │ OS Kernel                 │
              │ (scheduler, futex,        │
              │  context switch)          │
              └─────────────┬─────────────┘
                            │
              ┌─────────────▼─────────────┐
              │ CPU Hardware              │
              │ (caches L1/L2/L3,         │
              │  write buffers, MESI,     │
              │  CMPXCHG instruction)     │
              └───────────────────────────┘
```

Concurrency bugs can originate at any layer. A race condition might be a JVM reordering issue (Part 2), a lock starvation bug (Part 3–4), or a pool misconfiguration (Part 6). This series gives you the vocabulary and tools to find them at each level.

## Key Concepts You'll Learn

- **Happens-before** — the formal rule that defines visibility between threads
- **`volatile`** — what it guarantees (visibility) and what it doesn't (atomicity)
- **Lock inflation** — how the JVM escalates intrinsic lock state under contention
- **CAS** — the CPU primitive that powers all lock-free data structures
- **Work-stealing** — how `ForkJoinPool` keeps all threads busy
- **Carrier threads** — how virtual threads share OS threads transparently
- **Pinning** — the one thing that breaks virtual thread scalability

## What You'll Need

**JDK 21+**: Install from [adoptium.net](https://adoptium.net/) or use SDKMAN:

```bash
sdk install java 21.0.3-tem
java -version
# openjdk version "21.0.3" ...
```

**jcmd** and **jstack** (ship with the JDK):

```bash
jcmd        # list running JVM processes
jstack <pid>  # print thread dump
```

**JMH** for microbenchmarks (add to your Maven/Gradle project — see Part 5 for setup).

## Next Steps

In **Part 1**, we'll create threads the old way, trace what the JVM does under the hood, and use `jstack` to observe thread states live. You'll see exactly what a thread dump looks like and learn to read it.

Ready? Let's start with threads.

---

**Part 0 complete. Next: [Threads, the OS, and the JVM](/blog/java-concurrency-series-1-threads/)**
