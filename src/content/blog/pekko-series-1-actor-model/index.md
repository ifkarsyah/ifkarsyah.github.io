---
title: "Apache Pekko Series, Part 1: The Actor Model"
description: "What an actor is, how message passing replaces shared state, and how to create your first ActorSystem in Scala with Pekko Typed."
pubDate: 2026-02-23
author: "ifkarsyah"
domain: "Streaming"
stack: ["Pekko", "Scala"]
image:
  src: ./pekko-series.png
  alt: "Apache Pekko Series — The Actor Model"
---

The hardest part of concurrent programming is not writing concurrent code — it is reasoning about it. When two threads can modify the same variable, every piece of code becomes suspect. Every read might see stale data. Every write might overwrite another's work. Locks help, but locks compose badly: two correct subsystems can deadlock when combined.

The actor model takes a different approach. It eliminates shared mutable state entirely. Actors communicate only by passing immutable messages. No shared state means no races. No direct calls means no deadlocks.

## What is an Actor?

An actor is a computational entity with three things:

1. **A mailbox** — a queue of incoming messages
2. **Behavior** — logic that processes one message at a time
3. **State** — private, mutable, accessible only from within

```
        ┌──────────────────────────────────┐
        │            Actor                 │
        │                                  │
msg ──► │  mailbox ──► behavior(msg)       │
        │                ▼                 │
        │           private state          │
        └──────────────────────────────────┘
```

The key invariant: **an actor processes exactly one message at a time**. The mailbox serializes delivery. The behavior runs without any locking because no other code can touch the actor's state concurrently.

When processing a message, an actor can:
- Update its own state
- Send messages to other actors (including itself)
- Create new child actors
- Change its behavior for the next message

## Pekko Typed vs Classic

Pekko has two actor APIs. The classic API uses `receive` and returns `Receive`. The typed API, introduced in Akka 2.6 and the default in Pekko, uses `Behavior[T]` — the message type is encoded in the type system.

We use the typed API throughout this series. It eliminates a class of runtime errors by making the actor's accepted message type explicit.

## Your First Actor

Add Pekko to your `build.sbt`:

```scala
val PekkoVersion = "1.1.2"

libraryDependencies ++= Seq(
  "org.apache.pekko" %% "pekko-actor-typed" % PekkoVersion,
  "ch.qos.logback"    % "logback-classic"   % "1.5.6"
)
```

A minimal typed actor:

```scala
import org.apache.pekko.actor.typed.{ActorRef, ActorSystem, Behavior}
import org.apache.pekko.actor.typed.scaladsl.Behaviors

object Greeter {
  // The message type this actor accepts
  final case class Greet(whom: String, replyTo: ActorRef[Greeted])
  final case class Greeted(whom: String)

  // The actor's behavior — a pure function from (state, message) to next behavior
  def apply(): Behavior[Greet] =
    Behaviors.receive { (context, message) =>
      context.log.info("Hello, {}!", message.whom)
      message.replyTo ! Greeted(message.whom)
      Behaviors.same  // keep the same behavior for the next message
    }
}
```

Key observations:
- `Behavior[Greet]` — this actor only accepts `Greet` messages. Sending anything else is a compile error.
- `context.log` — the actor's logger, prefixed with the actor's path.
- `message.replyTo ! Greeted(...)` — the `!` operator (tell) sends a message asynchronously.
- `Behaviors.same` — return the same behavior unchanged.

## ActorSystem

The `ActorSystem` is the root of all actors. You create one per JVM (usually one per application):

```scala
import org.apache.pekko.actor.typed.ActorSystem

object Main extends App {
  // The guardian actor is the root of the hierarchy
  val system: ActorSystem[Greeter.Greet] =
    ActorSystem(Greeter(), "hello-pekko")

  // Send a message — but who receives the reply?
  // We need a replyTo ActorRef. For top-level testing, use ask pattern.
  system.terminate()
}
```

For proper request-reply at the top level, use the ask pattern:

```scala
import org.apache.pekko.actor.typed.scaladsl.AskPattern._
import org.apache.pekko.util.Timeout
import scala.concurrent.duration._

implicit val timeout: Timeout = 3.seconds
implicit val ec = system.executionContext

val result: Future[Greeter.Greeted] =
  system.ask(ref => Greeter.Greet("World", ref))

result.foreach(g => println(s"Received: ${g.whom}"))
```

## Stateful Actors

Real actors hold state. In the typed API, state is passed as a parameter to the next behavior:

```scala
object Counter {
  sealed trait Command
  case object Increment extends Command
  final case class GetCount(replyTo: ActorRef[Int]) extends Command

  def apply(count: Int = 0): Behavior[Command] =
    Behaviors.receive {
      case (_, Increment) =>
        apply(count + 1)                    // return a new Behavior with updated count

      case (_, GetCount(replyTo)) =>
        replyTo ! count
        Behaviors.same
    }
}
```

When the actor processes `Increment`, it returns `apply(count + 1)` — a new behavior with the incremented value captured in its closure. The actor's state lives in the call stack, not in a mutable field. This makes state transitions explicit and easy to reason about.

## Sending Messages

Actors communicate via `ActorRef[T]`. You cannot call methods on an actor directly — you can only send messages:

```scala
val counterRef: ActorRef[Counter.Command] =
  system.systemActorOf(Counter(), "counter")

counterRef ! Counter.Increment
counterRef ! Counter.Increment
counterRef ! Counter.GetCount(???)  // needs a replyTo
```

The `!` (tell) operator is fire-and-forget: it enqueues the message and returns immediately. There is no return value, no blocking, no callback at this point.

## Key Takeaways

- An actor has a mailbox, behavior, and private state — no sharing
- `Behavior[T]` encodes the accepted message type at compile time
- State change = returning a new behavior with updated parameters
- `ActorRef[T]` is the only way to interact with an actor
- `!` (tell) is asynchronous and non-blocking
- `ActorSystem` is the root of the actor hierarchy — one per application

**Next:** [Actor Lifecycle & Supervision](/blog/pekko-series-2-actor-lifecycle)
