---
title: "Apache Pekko Series, Part 8: CQRS & Projections"
description: "Separating write models from read models with CQRS. Pekko Projection — consuming the event journal to build materialized views, exactly-once processing, and offset tracking."
pubDate: 2026-03-02
author: "ifkarsyah"
domain: "Streaming"
stack: ["Pekko", "Scala"]
image:
  src: ./pekko-series.png
  alt: "Apache Pekko Series — CQRS & Projections"
---

When you optimize a database for writes, you often compromise reads, and vice versa. **CQRS** (Command Query Responsibility Segregation) resolves this tension by separating the two sides completely: commands (writes) go to one model, queries (reads) go to another.

Combined with event sourcing (Part 3), CQRS becomes natural: the event journal is the write model. Projections transform that journal into specialized read models — a relational table for reports, a search index for full-text queries, a cache for low-latency lookups.

## The Pattern

```
                Commands
                    │
                    ▼
         ┌──────────────────┐
         │  EventSourced    │  ◄── write side (actors + journal)
         │     Actors       │
         └────────┬─────────┘
                  │  events written to journal
                  ▼
         ┌──────────────────┐
         │  Event Journal   │  (Cassandra, JDBC, etc.)
         └────────┬─────────┘
                  │  consumed by projections
                  ▼
    ┌─────────────────────────────┐
    │         Projections         │
    ├──────────┬──────────────────┤
    │  SQL DB  │  Elasticsearch   │  ◄── read side (materialized views)
    └──────────┴──────────────────┘
                  │
                  ▼
               Queries
```

The read models can be rebuilt from scratch at any time by replaying the journal. They are derived data — the source of truth is always the event log.

## Pekko Projection

`pekko-projection` is the official module for consuming event journals and building projections. It handles:
- **Offset tracking** — remembers where processing stopped; resumes on restart
- **Exactly-once / at-least-once semantics** — configurable per handler
- **Backoff and retries** — on handler failure

```sbt
val PekkoProjectionVersion = "1.1.0"

libraryDependencies ++= Seq(
  "org.apache.pekko" %% "pekko-projection-core"        % PekkoProjectionVersion,
  "org.apache.pekko" %% "pekko-projection-eventsourced" % PekkoProjectionVersion,
  "org.apache.pekko" %% "pekko-projection-jdbc"        % PekkoProjectionVersion
)
```

## Defining a Projection

Example: projecting `BankAccount` events into a SQL read table.

```scala
import org.apache.pekko.projection.eventsourced.EventEnvelope
import org.apache.pekko.projection.eventsourced.scaladsl.EventSourcedProvider
import org.apache.pekko.projection.jdbc.scaladsl.JdbcProjection
import org.apache.pekko.projection.scaladsl.Handler

// 1. The handler: receives each event and updates the read model
class AccountSummaryHandler(session: DatabaseSession)
    extends Handler[EventEnvelope[BankAccount.Event]] {

  override def process(envelope: EventEnvelope[BankAccount.Event]): Future[Done] = {
    val accountId = envelope.persistenceId
    envelope.event match {
      case BankAccount.Deposited(amount) =>
        session.execute(
          "INSERT INTO account_balance (id, balance) VALUES (?, ?) " +
          "ON CONFLICT (id) DO UPDATE SET balance = account_balance.balance + ?",
          accountId, amount, amount
        )
      case BankAccount.Withdrawn(amount) =>
        session.execute(
          "UPDATE account_balance SET balance = balance - ? WHERE id = ?",
          amount, accountId
        )
    }
  }
}

// 2. The source: read from the event journal
val sourceProvider =
  EventSourcedProvider.eventsByTag[BankAccount.Event](
    system,
    readJournalPluginId = "pekko.persistence.r2dbc.query",
    tag                 = "bank-account"
  )

// 3. Wire it together
val projection =
  JdbcProjection.exactlyOnce(
    projectionId    = ProjectionId("account-summary", "all"),
    sourceProvider  = sourceProvider,
    sessionFactory  = () => new DatabaseSession(dataSource),
    handler         = () => new AccountSummaryHandler(new DatabaseSession(dataSource))
  )
```

## Running Projections

Projections run as actors. Start them with `ProjectionBehavior`:

```scala
import org.apache.pekko.projection.ProjectionBehavior

system.systemActorOf(
  ProjectionBehavior(projection),
  "account-summary-projection"
)
```

In a cluster, use `ShardedDaemonProcess` to distribute projections across nodes:

```scala
import org.apache.pekko.cluster.sharding.typed.ShardedDaemonProcess

ShardedDaemonProcess(system).init[ProjectionBehavior.Command](
  name         = "account-projections",
  numberOfInstances = 4,
  behaviorFactory  = idx =>
    ProjectionBehavior(
      JdbcProjection.exactlyOnce(
        projectionId   = ProjectionId("account-summary", idx.toString),
        sourceProvider = EventSourcedProvider.eventsByTag[BankAccount.Event](
                           system, readJournalPlugin, s"tag-$idx"),
        ...
      )
    ),
  stopMessage = ProjectionBehavior.Stop
)
```

Each projection instance handles a subset of entity tags. This distributes the journal read load across the cluster.

## Offset Tracking and Recovery

Pekko Projection stores the current offset (journal position) in a database table after each processed event. On restart, it reads the last stored offset and resumes from there — no reprocessing of already-handled events.

`exactlyOnce` wraps the handler and offset update in the same database transaction, ensuring both succeed or both fail together. This prevents duplicate reads on retry.

## Key Takeaways

- CQRS separates writes (actors + journal) from reads (projections + read stores)
- Projections are always derivable from the event journal — rebuild anytime
- `pekko-projection` handles offset tracking, retry, and exactly-once semantics
- `exactlyOnce` mode: handler + offset update in one transaction (requires JDBC/R2DBC)
- Use `ShardedDaemonProcess` to distribute projection work across the cluster
- Tag events at write time (`withTagger`) to enable filtered projection reads

**Next:** [Production Best Practices](/blog/pekko-series-9-production)
