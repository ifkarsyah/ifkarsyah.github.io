---
title: "Java Concurrency Series, Part 2: The Java Memory Model & Visibility"
description: "Why can a thread see stale data written by another? Understand CPU caches, write buffers, instruction reordering, and the happens-before relation that makes volatile work."
pubDate: 2026-03-09
author: "ifkarsyah"
domain: "Backend"
stack: ["Java"]
image:
  src: ./java-concurrency-series.png
  alt: "Java Concurrency Internals"
---

Now that you understand what a thread is (Part 1), here's a question that should bother you: if Thread A writes to a field, can Thread B see it?

The intuitive answer is "yes, they share heap memory." The correct answer is "it depends — and by default, maybe not." CPUs have caches. Compilers reorder instructions. Without explicit synchronization, the JVM makes no guarantee about when (or whether) a write by one thread becomes visible to another.

**Key question:** Why can a running thread see stale data written by another thread?

## The Hardware Reality

Modern CPUs don't read directly from RAM on every memory access. They have a cache hierarchy:

```
CPU Core 0                CPU Core 1
┌──────────┐              ┌──────────┐
│    L1    │  (4 KB, ~1ns)│    L1    │
│  cache   │              │  cache   │
└────┬─────┘              └────┬─────┘
     │                         │
┌────▼─────┐              ┌────▼─────┐
│    L2    │  (256 KB, ~4ns)  L2    │
│  cache   │              │  cache   │
└────┬─────┘              └────┬─────┘
     │                         │
     └────────────┬────────────┘
              ┌───▼────┐
              │   L3   │  (8–32 MB, ~30ns)
              │ (shared)│
              └───┬────┘
                  │
              ┌───▼────┐
              │  RAM   │  (~100ns)
              └────────┘
```

When Core 0 writes `x = 1`, the value goes into L1/L2 cache first. It may not reach RAM (or Core 1's view) immediately. Core 1 might still read `x = 0` from its own cache — even after Core 0's write.

Additionally, CPUs and JIT compilers reorder instructions for performance. A write to `x` and a write to `ready` might be reordered so `ready` is visible before `x`.

## The Broken Flag Pattern

This is one of the most common concurrency bugs in Java:

```java
public class BrokenFlag {
    static boolean ready = false;
    static int value = 0;

    public static void main(String[] args) throws InterruptedException {
        Thread writer = new Thread(() -> {
            value = 42;
            ready = true;  // "signal" that value is ready
        });

        Thread reader = new Thread(() -> {
            while (!ready) {
                // spin-wait
            }
            System.out.println("Value: " + value);
        });

        reader.start();
        writer.start();
    }
}
```

Expected output: `Value: 42`

Possible outcomes without proper synchronization:
1. The reader spins forever — it never sees `ready = true` (cached in register)
2. The reader sees `ready = true` but prints `Value: 0` — because `value = 42` was reordered after `ready = true`
3. It works fine in your test but fails in production under load

All three are valid under the JMM. The code is broken.

## The Java Memory Model

The JMM (defined in the Java Language Specification, §17) specifies the rules under which one thread's writes become visible to another. It doesn't say anything about "which cache" or "when data flushes to RAM." It's a higher-level abstraction: the **happens-before** relation.

**Happens-before rule:** If action A happens-before action B, then A's effects are visible to B.

The JMM defines several edges that establish happens-before:

| Rule | Happens-before |
|------|---------------|
| Program order | Each action in a thread happens-before the next action in the same thread |
| Monitor unlock | Unlocking a monitor happens-before any subsequent lock of that monitor |
| Volatile write | A write to a volatile field happens-before all subsequent reads of that field |
| Thread start | `thread.start()` happens-before any action in the started thread |
| Thread join | All actions in a thread happen-before `thread.join()` returns |
| Transitivity | If A hb B and B hb C, then A hb C |

Without one of these edges, there is **no guaranteed visibility**.

## `volatile`: The Simplest Fix

Declaring a field `volatile` creates a happens-before edge between writes and reads:

```java
public class FixedFlag {
    static volatile boolean ready = false;
    static volatile int value = 0;

    public static void main(String[] args) throws InterruptedException {
        Thread writer = new Thread(() -> {
            value = 42;   // write 1
            ready = true; // write 2: volatile write
        });

        Thread reader = new Thread(() -> {
            while (!ready) { // volatile read
                // spin-wait
            }
            // happens-before guarantees value = 42 is visible here
            System.out.println("Value: " + value);
        });

        reader.start();
        writer.start();
    }
}
```

The volatile write to `ready` happens-before the volatile read of `ready`. And by program order, `value = 42` happens-before `ready = true`. By transitivity, `value = 42` happens-before the print.

Output is guaranteed: `Value: 42`.

## What `volatile` Guarantees (and Doesn't)

`volatile` gives you:

- **Visibility:** Every write is immediately visible to all threads
- **Ordering:** No reordering of reads/writes around a volatile access

`volatile` does NOT give you:

- **Atomicity for compound operations.** `i++` on a volatile is still a race:

```java
static volatile int counter = 0;

// In two threads simultaneously:
counter++;   // read counter, add 1, write counter — NOT atomic
```

Two threads both reading `0`, adding `1`, and writing `1` → result is `1`, not `2`. For this you need `AtomicInteger` (Part 5).

## Demonstrating the Visibility Bug

Let's write a reproducible demo. The trick: use a tight loop and disable JIT with `-Xint` to force the issue:

```java
public class VisibilityDemo {
    static boolean stop = false;  // not volatile

    public static void main(String[] args) throws InterruptedException {
        Thread runner = new Thread(() -> {
            long count = 0;
            while (!stop) {
                count++;
            }
            System.out.println("Stopped at count: " + count);
        });

        runner.start();
        Thread.sleep(1000);
        stop = true;
        System.out.println("Set stop = true");
        runner.join(3000);

        if (runner.isAlive()) {
            System.out.println("Thread is still running! Visibility bug confirmed.");
            runner.interrupt();
        }
    }
}
```

Run with:

```bash
java -server VisibilityDemo
```

The `-server` JIT is more aggressive about optimizations. You'll often see the thread spin forever because the JIT hoists `stop` into a register.

Now fix it:

```java
static volatile boolean stop = false;  // add volatile
```

The thread always terminates promptly.

## Double-Checked Locking: A Case Study

Double-checked locking is a classic pattern to lazily initialize a singleton. The broken version (pre-Java 5):

```java
public class BrokenSingleton {
    private static BrokenSingleton instance;

    public static BrokenSingleton getInstance() {
        if (instance == null) {          // check 1 (no lock)
            synchronized (BrokenSingleton.class) {
                if (instance == null) {  // check 2 (with lock)
                    instance = new BrokenSingleton();
                }
            }
        }
        return instance;
    }
}
```

Why is this broken? `instance = new BrokenSingleton()` is not atomic. It compiles to roughly:
1. Allocate memory
2. Write default values to fields
3. Run the constructor
4. Assign the reference to `instance`

Steps 3 and 4 can be reordered. Another thread doing check 1 might see a non-null `instance` that hasn't had its constructor run yet — a partially constructed object.

The fix, valid since Java 5:

```java
public class CorrectSingleton {
    private static volatile CorrectSingleton instance;  // volatile!

    public static CorrectSingleton getInstance() {
        if (instance == null) {
            synchronized (CorrectSingleton.class) {
                if (instance == null) {
                    instance = new CorrectSingleton();
                }
            }
        }
        return instance;
    }
}
```

The `volatile` on `instance` prevents the constructor-reference reordering. The write to `instance` is a volatile write, so any thread that reads a non-null `instance` is guaranteed to see the fully constructed object.

Alternatively, use the initialization-on-demand holder idiom (no volatile needed):

```java
public class HolderSingleton {
    private HolderSingleton() {}

    private static class Holder {
        static final HolderSingleton INSTANCE = new HolderSingleton();
    }

    public static HolderSingleton getInstance() {
        return Holder.INSTANCE;
    }
}
```

Class initialization is thread-safe by the JLS. The `Holder` class is only initialized on first access to `getInstance()`, and the JVM's class-loading lock ensures only one thread initializes it.

## Memory Barriers Under the Hood

When the JVM generates machine code for a volatile write/read, it inserts **memory barriers** (also called memory fences). On x86-64:

- Volatile write → `SFENCE` or `LOCK XCHG` (store fence)
- Volatile read → `LFENCE` (load fence, though x86 often doesn't need an explicit one)

These instructions tell the CPU to flush pending writes to the cache coherence protocol (MESI) before proceeding. Other cores see the write as soon as they next read that cache line.

On weaker architectures (ARM, POWER), barriers are more frequently needed. Java's `volatile` abstracts over all of this — your code works correctly on all platforms.

## When to Use `volatile`

Use `volatile` for:

- **Status flags** — `volatile boolean running = true`
- **One-time safe publication** — writing a fully constructed object reference once
- **Counters read by one thread, written by one thread** (but not for `++`, use `AtomicLong`)

Do NOT use `volatile` for:

- Check-then-act patterns (`if (x != null) x.doSomething()`)
- Increment operations (`counter++`)
- Any compound operation where you need atomicity across multiple reads and writes

## Troubleshooting: Diagnosing Visibility Issues

Visibility bugs are notoriously hard to reproduce because they depend on JIT compilation behavior and CPU caching. Tips:

1. **Run with `-server` flag** — the server JIT is more likely to expose the bug
2. **Enable JIT logging** — `-XX:+PrintCompilation` shows what's being compiled
3. **Use `-Xint`** to disable JIT entirely — if the bug disappears, it's JIT-related
4. **Thread sanitizer** — third-party tools like [ThreadSanitizer (via LLVM)](https://clang.llvm.org/docs/ThreadSanitizer.html) can detect races at the bytecode level

## Summary

| Concept | Key Point |
|---------|-----------|
| CPU caches | Writes are local first; other cores may see stale data |
| Happens-before | The formal rule for visibility in the JMM |
| `volatile` | Establishes happens-before between write and all subsequent reads |
| `volatile` guarantee | Visibility and ordering — NOT atomicity |
| Double-checked locking | Requires `volatile` on the instance field |
| Memory barriers | CPU-level instructions; `volatile` inserts them automatically |

**Next:** In Part 3, we'll look at `synchronized` — Java's built-in mutual exclusion mechanism. We'll examine object headers, lock state inflation, and how the JVM detects and reports deadlocks.

---

**Part 2 complete. Next: [synchronized & Intrinsic Locks](/blog/java-concurrency-series-3-synchronized/)**
