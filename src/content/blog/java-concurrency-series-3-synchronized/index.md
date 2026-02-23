---
title: "Java Concurrency Series, Part 3: synchronized & Intrinsic Locks"
description: "What does synchronized actually do at the JVM level? Explore object headers, lock state inflation from biased to fat locks, wait/notify semantics, and deadlock diagnosis with jstack."
pubDate: 2026-03-16
author: "ifkarsyah"
domain: "Backend"
stack: ["Java"]
image:
  src: ./java-concurrency-series.png
  alt: "Java Concurrency Internals"
---

In Part 2, we saw that `volatile` gives visibility but not atomicity. When you need to protect a compound operation — read a value, compute something, write it back — you need mutual exclusion. The simplest tool Java offers is `synchronized`. But behind this single keyword is a surprisingly sophisticated machinery inside the JVM.

**Key question:** What does `synchronized` actually do at the JVM level?

## Intrinsic Locks (Monitors)

Every Java object has an associated **monitor** — also called an **intrinsic lock**. When you write `synchronized(obj)`, you're competing to acquire that monitor.

```java
synchronized (lock) {
    // critical section: only one thread here at a time
}
```

Only one thread can hold a monitor at a time. All other threads trying to enter the `synchronized` block transition to `BLOCKED` state and wait.

The monitor also carries:
- A **wait set** — threads that called `obj.wait()`
- A **entry set** — threads waiting to acquire the lock

```
┌──────────────── Object Monitor ─────────────────┐
│                                                 │
│  owner: Thread A (holds the lock)               │
│                                                 │
│  entry set: [Thread B, Thread C]  (BLOCKED)     │
│  wait set:  [Thread D]            (WAITING)     │
│                                                 │
└─────────────────────────────────────────────────┘
```

## The Object Header: Where Lock State Lives

Every Java object on the heap has a **header**. On a 64-bit JVM (with compressed oops disabled), it's 16 bytes:

```
┌──────────────────────────────────────────────────────────────────┐
│ Mark Word (8 bytes)  │  Class Pointer (8 bytes)                  │
└──────────────────────────────────────────────────────────────────┘
```

The **mark word** is multipurpose. Depending on the lock state, it contains different information:

```
State           Mark Word contents
──────────────────────────────────────────────────────────────
Unlocked        identity hash code | age | 0 | 01
Biased locked   thread ID | epoch | age | 1 | 01
Thin locked     pointer to lock record on owning thread's stack | 00
Fat locked      pointer to inflated monitor object             | 10
GC marked       forwarding pointer                             | 11
```

This is how the JVM avoids allocating a full monitor object for every synchronization.

## Lock Inflation: Biased → Thin → Fat

The JVM uses three lock strategies, escalating under contention:

### 1. Biased Locking (Java 8–14, disabled in 15+)

If only one thread ever accesses the object, the JVM writes that thread's ID into the mark word. Future locks by the same thread are nearly free — no CAS, just a check.

```
First lock: write threadID into mark word
Subsequent locks by same thread: just check "is this my thread?" → yes → done
```

When a second thread tries to lock: the bias is revoked (requires a safepoint), and the object transitions to thin locking.

Note: Biased locking was disabled by default in Java 15 (JEP 374) because the revocation overhead outweighed gains in modern workloads.

### 2. Thin Locking (Lightweight)

For low-contention scenarios. Uses a CAS (compare-and-swap) operation to claim the lock:

1. Thread creates a **lock record** on its own stack
2. Copies the mark word to the lock record
3. CAS the mark word to a pointer to the lock record
4. If CAS succeeds: thread owns the lock
5. If CAS fails: another thread got there first → inflate to fat lock

```
Thread A's stack:
┌──────────────────────────┐
│ Lock Record              │
│ displaced mark word: ... │ ◄── mark word points here
└──────────────────────────┘
```

### 3. Fat Locking (Inflated)

When contention is detected, the JVM allocates a full `ObjectMonitor` object. This is backed by an OS mutex (usually `pthread_mutex_t` on Linux). Threads block in the OS, allowing the scheduler to run other work.

Fat locks are expensive compared to thin locks because they involve system calls, but they're necessary when multiple threads genuinely compete.

## `synchronized` in Bytecode

Given this code:

```java
public void increment() {
    synchronized (this) {
        count++;
    }
}
```

The bytecode uses `monitorenter` and `monitorexit`:

```
monitorenter    // acquire the monitor
iload count
iinc count 1
istore count
monitorexit     // release the monitor
// (exception path also calls monitorexit)
```

A `synchronized` method has the `ACC_SYNCHRONIZED` flag in its method descriptor — the JVM implicitly enters and exits the monitor.

## Building a Bounded Blocking Queue

Let's put `synchronized` + `wait/notify` to work with a real producer-consumer implementation:

```java
public class BoundedBlockingQueue<T> {
    private final Queue<T> queue = new LinkedList<>();
    private final int capacity;

    public BoundedBlockingQueue(int capacity) {
        this.capacity = capacity;
    }

    public synchronized void put(T item) throws InterruptedException {
        while (queue.size() == capacity) {
            wait();  // release lock, park in wait set
        }
        queue.add(item);
        notifyAll();  // wake all waiting consumers
    }

    public synchronized T take() throws InterruptedException {
        while (queue.isEmpty()) {
            wait();  // release lock, park in wait set
        }
        T item = queue.poll();
        notifyAll();  // wake all waiting producers
        return item;
    }

    public synchronized int size() {
        return queue.size();
    }
}
```

Key points:
- `wait()` releases the lock and adds the thread to the wait set
- `notifyAll()` moves all threads from the wait set back to the entry set (they re-compete for the lock)
- The `while` loop (not `if`) re-checks the condition after waking — because another thread may have changed state between the notify and the re-lock

Test it:

```java
BoundedBlockingQueue<Integer> q = new BoundedBlockingQueue<>(5);

Thread producer = new Thread(() -> {
    for (int i = 0; i < 20; i++) {
        try {
            q.put(i);
            System.out.println("Produced: " + i + " | size=" + q.size());
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}, "producer");

Thread consumer = new Thread(() -> {
    for (int i = 0; i < 20; i++) {
        try {
            int item = q.take();
            System.out.println("Consumed: " + item + " | size=" + q.size());
            Thread.sleep(50); // simulate slow consumer
        } catch (InterruptedException e) { Thread.currentThread().interrupt(); }
    }
}, "consumer");

producer.start();
consumer.start();
```

## `notify` vs `notifyAll`

- `notify()` wakes exactly one waiting thread (chosen arbitrarily by the JVM)
- `notifyAll()` wakes all waiting threads; they re-compete for the lock

Use `notify()` only when:
1. All threads waiting are waiting for the same condition
2. Any one of them can make progress

Otherwise use `notifyAll()` — it's safer and avoids missed wakeups.

## Deadlocks

A deadlock occurs when two or more threads each hold a lock and wait for the other's lock:

```java
Object lockA = new Object();
Object lockB = new Object();

Thread t1 = new Thread(() -> {
    synchronized (lockA) {
        System.out.println("T1 holds A, waiting for B");
        synchronized (lockB) { /* ... */ }
    }
}, "t1");

Thread t2 = new Thread(() -> {
    synchronized (lockB) {
        System.out.println("T2 holds B, waiting for A");
        synchronized (lockA) { /* ... */ }
    }
}, "t2");

t1.start();
t2.start();
```

Both threads will hang forever. Get the thread dump:

```bash
jstack <pid>
```

```
Found one Java-level deadlock:
=============================
"t2":
  waiting to lock monitor 0x00007f... (object 0x..., a java.lang.Object),
  which is held by "t1"
"t1":
  waiting to lock monitor 0x00007f... (object 0x..., a java.lang.Object),
  which is held by "t2"

Java stack information for the threads listed above:
===================================================
"t2":
        at DeadlockDemo.lambda$main$1(DeadlockDemo.java:18)
        - waiting to lock <0x...> (a java.lang.Object)
        - locked <0x...> (a java.lang.Object)
"t1":
        at DeadlockDemo.lambda$main$0(DeadlockDemo.java:10)
        - waiting to lock <0x...> (a java.lang.Object)
        - locked <0x...> (a java.lang.Object)
```

`jstack` detects and reports deadlocks automatically. In production, use `jcmd <pid> Thread.print` — same output, safer on live processes.

**Prevention strategies:**
1. Always acquire locks in a consistent global order
2. Use `ReentrantLock.tryLock(timeout)` — can back off on failure (Part 4)
3. Minimize lock scope and nesting

## Lock Scope: Method vs Block

```java
// Locks the entire method — often too coarse
public synchronized void processAll() {
    // expensive work
}

// Locks only what's shared
public void processAll() {
    expensivePrework();  // no lock needed
    synchronized (this) {
        updateSharedState();  // lock only here
    }
    expensivePostwork(); // no lock needed
}
```

Narrow lock scope reduces contention. Don't hold locks during I/O, network calls, or long computations.

## Reentrancy

Intrinsic locks are **reentrant** — a thread can re-acquire a lock it already holds:

```java
synchronized void outer() {
    inner(); // safe: same thread, same lock
}

synchronized void inner() {
    // works fine — not deadlocked
}
```

The JVM tracks a **hold count**. Each `monitorenter` increments it; each `monitorexit` decrements it. The lock is released when the count reaches 0.

## Troubleshooting: Lock Contention

High lock contention shows up as threads spending time in `BLOCKED` state. Diagnose with:

```bash
# Count threads by state
jstack <pid> | grep "java.lang.Thread.State" | sort | uniq -c

# Look for threads blocking on your class
jstack <pid> | grep -A5 "BLOCKED"
```

Or use JFR (Java Flight Recorder):

```bash
jcmd <pid> JFR.start duration=30s filename=recording.jfr
# analyze with JDK Mission Control
```

JFR's "Java Monitor Blocked" event shows exactly which locks are hot.

## Summary

| Concept | Key Point |
|---------|-----------|
| Intrinsic lock | Every object has one; `synchronized` acquires it |
| Mark word | 8 bytes in object header; encodes lock state |
| Biased → thin → fat | Lock escalates under contention |
| `wait()` | Releases lock, parks in wait set |
| `notifyAll()` | Moves all waiters to entry set; they re-compete |
| Deadlock | `jstack` detects automatically; prevent with consistent lock ordering |
| Reentrancy | Same thread can re-lock; tracked by hold count |

**Next:** In Part 4, we'll look at `java.util.concurrent` — specifically `ReentrantLock`, `StampedLock`, and `Condition`. These give you capabilities `synchronized` can't: timed lock attempts, interruptible waiting, and optimistic reads.

---

**Part 3 complete. Next: [java.util.concurrent Building Blocks](/blog/java-concurrency-series-4-reentrantlock/)**
