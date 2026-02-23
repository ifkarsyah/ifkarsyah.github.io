---
title: "Apache Pekko Series, Part 3: Persistence & Event Sourcing"
description: "How EventSourcedBehavior works in Pekko: journals, snapshots, and recovery. Build actors whose state survives restarts by recording every change as an immutable event."
pubDate: 2026-02-25
author: "ifkarsyah"
domain: "Streaming"
stack: ["Pekko", "Scala"]
image:
  src: ./pekko-series.png
  alt: "Apache Pekko Series — Persistence & Event Sourcing"
---

A regular actor loses all its state when it restarts. For a shopping cart or a bank account, that is unacceptable. **Pekko Persistence** solves this by journaling every state change as an event. On recovery, the actor replays its journal to reconstruct its state — exactly as it was before the failure.

This is event sourcing at the actor level.

## The Event Sourcing Model

Traditional persistence stores the current state: `UPDATE accounts SET balance = 950 WHERE id = 42`. You see the result, not the history.

Event sourcing stores the sequence of changes:

```
Event 1: AccountOpened(id=42, initialBalance=1000)
Event 2: MoneyWithdrawn(id=42, amount=50)
```

The current state is derived by replaying all events from the beginning. This gives you a complete audit log, the ability to replay into different projections, and trivial recovery: just replay the journal.

## EventSourcedBehavior

Pekko's `EventSourcedBehavior[Command, Event, State]` has three type parameters:

- **Command** — messages the actor receives
- **Event** — what gets written to the journal
- **State** — the actor's in-memory state

It requires three pure functions:

```scala
import org.apache.pekko.persistence.typed.scaladsl.{Effect, EventSourcedBehavior}
import org.apache.pekko.persistence.typed.PersistenceId

object BankAccount {

  // --- Commands (incoming messages) ---
  sealed trait Command
  final case class Deposit(amount: BigDecimal, replyTo: ActorRef[Done])    extends Command
  final case class Withdraw(amount: BigDecimal, replyTo: ActorRef[Either[String, Done]]) extends Command
  final case class GetBalance(replyTo: ActorRef[BigDecimal]) extends Command

  // --- Events (what gets persisted) ---
  sealed trait Event
  final case class Deposited(amount: BigDecimal)  extends Event
  final case class Withdrawn(amount: BigDecimal)  extends Event

  // --- State ---
  final case class Balance(amount: BigDecimal)

  def apply(accountId: String): Behavior[Command] =
    EventSourcedBehavior[Command, Event, Balance](
      persistenceId  = PersistenceId.ofUniqueId(accountId),
      emptyState     = Balance(0),

      // 1. commandHandler: Command + State => Effect (what to persist)
      commandHandler = (state, command) => command match {
        case Deposit(amount, replyTo) =>
          Effect
            .persist(Deposited(amount))
            .thenRun(_ => replyTo ! Done)

        case Withdraw(amount, replyTo) =>
          if (state.amount >= amount)
            Effect
              .persist(Withdrawn(amount))
              .thenRun(_ => replyTo ! Right(Done))
          else
            Effect
              .none  // reject without persisting
              .thenRun(_ => replyTo ! Left("Insufficient funds"))

        case GetBalance(replyTo) =>
          Effect.none.thenRun(_ => replyTo ! state.amount)
      },

      // 2. eventHandler: State + Event => new State (pure function, no side effects)
      eventHandler = (state, event) => event match {
        case Deposited(amount) => Balance(state.amount + amount)
        case Withdrawn(amount) => Balance(state.amount - amount)
      }
    )
}
```

The critical constraint: the `eventHandler` must be a **pure function** with no side effects. It will be called both when processing live commands and during recovery. Side effects in event handlers cause divergence between live state and recovered state.

## Recovery

When a `BankAccount` actor starts (or restarts), Pekko:

1. Reads all persisted events for this `persistenceId` from the journal
2. Replays them through the `eventHandler` starting from `emptyState`
3. Delivers the reconstructed state before the first command is processed

```
Journal: [Deposited(1000), Withdrawn(50)]

Recovery:
  emptyState = Balance(0)
  + Deposited(1000) → Balance(1000)
  + Withdrawn(50)   → Balance(950)

Actor starts with Balance(950) — no data loss
```

## Snapshots

For actors with long event histories, replaying thousands of events on every restart is slow. **Snapshots** save a point-in-time copy of the state. Recovery then loads the latest snapshot and replays only the events after it.

```scala
EventSourcedBehavior[Command, Event, Balance](...)
  .withRetention(RetentionCriteria.snapshotEvery(numberOfEvents = 100, keepNSnapshots = 2))
```

With this config, Pekko persists a snapshot every 100 events and keeps the 2 most recent. Recovery becomes: load snapshot + replay at most 100 events.

## Setup: Journal Plugin

Pekko Persistence requires a journal plugin. The in-memory journal is fine for tests:

```sbt
libraryDependencies += "org.apache.pekko" %% "pekko-persistence-typed"  % PekkoVersion
libraryDependencies += "org.apache.pekko" %% "pekko-persistence-testkit" % PekkoVersion % Test
```

For production, use JDBC or Cassandra:

```sbt
// JDBC journal (PostgreSQL, MySQL, etc.)
libraryDependencies += "org.apache.pekko" %% "pekko-persistence-jdbc" % "1.0.0"
```

`application.conf`:

```hocon
pekko.persistence.journal.plugin = "jdbc-journal"
pekko.persistence.snapshot-store.plugin = "jdbc-snapshot-store"

jdbc-journal {
  slick = ${slick}
}

slick {
  profile = "slick.jdbc.PostgresProfile$"
  db {
    url = "jdbc:postgresql://localhost:5432/pekko"
    user = "pekko"
    password = "secret"
  }
}
```

## Key Takeaways

- `EventSourcedBehavior` separates commands (intent) from events (facts) from state (derived)
- The event handler must be pure — it runs during both live processing and recovery
- `persistenceId` is the unique identifier for an actor's event stream — choose it carefully
- `Effect.persist(event).thenRun(sideEffect)` — persist first, side effects after
- `Effect.none` — reject or query without writing to the journal
- Snapshots cap recovery time at the cost of additional storage writes

**Next:** [Streams & Reactive Processing](/blog/pekko-series-4-streams)
