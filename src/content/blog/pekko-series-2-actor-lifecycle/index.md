---
title: "Apache Pekko Series, Part 2: Actor Lifecycle & Supervision"
description: "How actors start, fail, and recover. Parent-child supervision hierarchies, restart vs stop vs escalate strategies, and building self-healing systems in Pekko."
pubDate: 2026-02-24
author: "ifkarsyah"
domain: "Streaming"
stack: ["Pekko", "Scala"]
image:
  src: ./pekko-series.png
  alt: "Apache Pekko Series — Actor Lifecycle & Supervision"
---

Failure is not an exception — it is a normal operating condition. Networks partition. Dependencies go down. Bugs surface in production. A resilient system does not try to prevent all failure; it assumes failure will happen and builds in recovery.

Pekko's approach is called **"let it crash"**. When an actor encounters an error it cannot handle, it stops or restarts — and its parent decides the recovery strategy. The failure is isolated, contained, and handled without human intervention.

## The Actor Lifecycle

Every actor goes through a defined lifecycle:

```
                  ┌─────────────┐
                  │   Created   │ ◄── ActorSystem.spawn / context.spawn
                  └──────┬──────┘
                         │ first message received (or immediately)
                         ▼
                  ┌─────────────┐
                  │   Running   │ ◄── processing messages normally
                  └──────┬──────┘
                  ┌──────┴──────┐
                  │             │
            failure          stop signal
                  │             │
                  ▼             ▼
           ┌──────────┐  ┌──────────┐
           │ Failed   │  │ Stopping │
           └──────┬───┘  └──────────┘
            supervisor            │
            decides               ▼
                  │         ┌──────────┐
            ┌─────┴──────┐  │ Stopped  │
            │  Restart   │  └──────────┘
            │  or Stop   │
            └────────────┘
```

Actors are created with `context.spawn(behavior, name)`. They stop when:
- They return `Behaviors.stopped`
- Their parent stops
- The supervisor decides to stop them after a failure

## Supervision

Every actor in Pekko has a parent. The parent is the **supervisor** — it decides what happens when the child fails.

```
         ┌──────────┐
         │  Parent  │  ◄── supervisor
         └────┬─────┘
              │ spawned
              ▼
         ┌──────────┐
         │  Child   │  ◄── throws exception
         └──────────┘
```

In the typed API, supervision is declared with `Behaviors.supervise`:

```scala
import org.apache.pekko.actor.typed.SupervisorStrategy

val supervisedChild: Behavior[SomeMessage] =
  Behaviors.supervise(SomeActor())
    .onFailure[RuntimeException](SupervisorStrategy.restart)
```

The three strategies:

| Strategy | What happens |
|----------|-------------|
| `restart` | Actor is stopped and re-created with a fresh state |
| `stop` | Actor is permanently stopped; parent is notified |
| `escalate` | Failure propagates to the parent's parent |

You can also configure restart with limits and backoff:

```scala
SupervisorStrategy.restartWithBackoff(
  minBackoff   = 200.millis,
  maxBackoff   = 10.seconds,
  randomFactor = 0.1
)

// Or limit restarts
SupervisorStrategy.restart.withLimit(maxNrOfRetries = 3, withinTimeRange = 1.minute)
```

## Lifecycle Hooks

Pekko Typed provides hooks for setup and cleanup:

```scala
object DatabaseWorker {
  def apply(): Behavior[Query] =
    Behaviors.setup { context =>
      // runs once when actor starts (or restarts)
      val connection = openDatabaseConnection()
      context.log.info("DatabaseWorker started, connection opened")

      Behaviors
        .receiveMessage[Query] { query =>
          val result = connection.execute(query.sql)
          query.replyTo ! result
          Behaviors.same
        }
        .receiveSignal {
          case (_, PostStop) =>
            // runs when actor is permanently stopped
            connection.close()
            context.log.info("DatabaseWorker stopped, connection closed")
            Behaviors.same
          case (_, PreRestart) =>
            // runs before a restart — clean up before the fresh start
            connection.close()
            Behaviors.same
        }
    }
}
```

`PostStop` fires on any stop — planned or after supervision. `PreRestart` fires just before a restart so you can release resources before the actor is re-created.

## Watching for Death

A parent can watch a child to receive a `Terminated` signal when the child stops:

```scala
object ParentActor {
  def apply(): Behavior[Nothing] =
    Behaviors.setup { context =>
      val child = context.spawn(ChildActor(), "child")
      context.watch(child)  // subscribe to Terminated signal

      Behaviors.receiveSignal {
        case (ctx, Terminated(`child`)) =>
          ctx.log.warn("Child stopped — taking action")
          // respawn, alert, etc.
          Behaviors.same
      }
    }
}
```

`context.watch` makes the parent receive a `Terminated(ref)` signal when the watched actor stops for any reason. Combined with `context.watchWith(ref, CustomMessage(...))`, you can inject domain-specific messages on termination.

## The Supervision Hierarchy in Practice

A common pattern is a three-level hierarchy:

```
ActorSystem (guardian)
    └── ServiceManager
            ├── DatabaseActor     ◄── supervise: restartWithBackoff
            ├── CacheActor        ◄── supervise: restart (3 retries)
            └── WorkerPool
                    ├── Worker-1  ◄── supervise: restart
                    ├── Worker-2
                    └── Worker-3
```

Each level supervises only its direct children. `ServiceManager` does not know about `Worker-1`'s failures unless `WorkerPool` escalates them. This keeps fault domains isolated and policies close to the actors they govern.

## Key Takeaways

- `Behaviors.supervise(child).onFailure[E](strategy)` — wrap a behavior with supervision
- `restart` gives the actor a clean state; `stop` terminates it; `escalate` moves the decision up
- `restartWithBackoff` prevents restart storms on persistent failures
- `Behaviors.setup` runs on every start (and restart) — use it for resource initialization
- `PostStop` / `PreRestart` signals give you cleanup hooks
- `context.watch(ref)` notifies the parent when any watched actor terminates

**Next:** [Persistence & Event Sourcing](/blog/pekko-series-3-persistence)
