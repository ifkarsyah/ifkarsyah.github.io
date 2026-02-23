---
title: "Apache Pekko Series, Part 4: Streams & Reactive Processing"
description: "Source, Flow, and Sink — the building blocks of Pekko Streams. Backpressure by design, composable pipelines, and how to process data without dropping messages or crashing."
pubDate: 2026-02-26
author: "ifkarsyah"
domain: "Streaming"
stack: ["Pekko", "Scala"]
image:
  src: ./pekko-series.png
  alt: "Apache Pekko Series — Streams & Reactive Processing"
---

Push-based data pipelines break under load. A producer that generates data faster than the consumer can process it fills up queues, blows up buffers, or starts dropping messages. The fix is **backpressure**: a mechanism for consumers to signal upstream how fast they can accept data.

Pekko Streams implements the [Reactive Streams](https://www.reactive-streams.org/) specification — a standard for asynchronous stream processing with non-blocking backpressure. The consumer drives the rate. The producer only sends what was requested.

## The Three Building Blocks

```
Source[Out]  ──►  Flow[In, Out]  ──►  Sink[In]
   │                   │                 │
   │         (transform, filter,         │
   │          map, async, etc.)          │
   └─────────────────────────────────────┘
                  RunnableGraph
```

- **`Source[Out, Mat]`** — produces elements; has no input
- **`Flow[In, Out, Mat]`** — transforms elements; has both input and output
- **`Sink[In, Mat]`** — consumes elements; has no output
- **`Mat`** — materialized value (the result produced when the stream runs, e.g., a `Future[Done]` or a count)

## Your First Stream

```sbt
libraryDependencies += "org.apache.pekko" %% "pekko-stream" % PekkoVersion
```

```scala
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.stream.scaladsl._

implicit val system: ActorSystem[Nothing] =
  ActorSystem(Behaviors.empty, "streams-example")
implicit val ec = system.executionContext

val result: Future[Int] =
  Source(1 to 100)                 // Source[Int]
    .filter(_ % 2 == 0)            // Flow[Int, Int]: keep even numbers
    .map(_ * 10)                   // Flow[Int, Int]: multiply
    .runWith(Sink.fold(0)(_ + _))  // Sink[Int, Future[Int]]: sum

result.foreach(sum => println(s"Sum of even*10: $sum"))
// Output: Sum of even*10: 27500
```

The stream does not run until `.runWith(sink)` or `.run()` is called — this is the **materialization** step. Before that, it is just a description (a `Graph`).

## Backpressure in Action

Pekko Streams propagates demand upstream automatically. A slow sink applies backpressure to all upstream stages:

```scala
Source
  .tick(initialDelay = 0.seconds, interval = 1.millis, tick = "tick")  // 1000/sec
  .mapAsync(parallelism = 4) { _ =>
    Future {
      Thread.sleep(100)  // simulate slow processing
      "processed"
    }
  }
  .runWith(Sink.ignore)
// The source will slow down automatically — backpressure prevents overflow
```

Compare this to a raw `Iterator` or `Observable`: if processing is slow you buffer, drop, or crash. With Pekko Streams you wait — the source is paused until the downstream is ready.

## Common Operators

```scala
val numbers = Source(1 to 1000)

// Transform
numbers.map(_ * 2)
numbers.mapConcat(n => List(n, n + 1))  // flatMap for elements

// Filter
numbers.filter(_ > 500)
numbers.take(10)
numbers.drop(10)

// Async processing
numbers.mapAsync(parallelism = 8)(n => Future(expensiveCompute(n)))
numbers.mapAsyncUnordered(8)(n => Future(expensiveCompute(n)))  // faster, order not preserved

// Grouping
numbers.grouped(10)           // Source[Seq[Int]]
numbers.sliding(3)            // Source[Seq[Int]] with a sliding window
numbers.groupedWithin(10, 1.second)  // batch by count OR time

// Throttle
numbers.throttle(elements = 100, per = 1.second)
```

## Fan-out and Fan-in

Streams can branch and merge using `GraphDSL`:

```scala
val graph = RunnableGraph.fromGraph(GraphDSL.create() { implicit b =>
  import GraphDSL.Implicits._

  val broadcast = b.add(Broadcast[Int](2))  // one input, two outputs
  val merge     = b.add(Merge[String](2))   // two inputs, one output

  val source = Source(1 to 10)
  val sink   = Sink.foreach[String](println)

  source ~> broadcast
            broadcast.out(0) ~> Flow[Int].map(n => s"path-A: $n") ~> merge
            broadcast.out(1) ~> Flow[Int].map(n => s"path-B: ${n * 10}") ~> merge
                                                                    merge ~> sink

  ClosedShape
})

graph.run()
```

## Integration with Actors

You can connect streams to actors using `ActorSource` and `ActorSink`, or the lower-level `ask` pattern:

```scala
import org.apache.pekko.stream.scaladsl.Flow
import org.apache.pekko.pattern.ask

val workerRef: ActorRef[WorkItem] = ...

val processingFlow: Flow[WorkItem, WorkResult, NotUsed] =
  Flow[WorkItem].mapAsync(4) { item =>
    workerRef.ask[WorkResult](ref => item.copy(replyTo = ref))
  }
```

Streams provide the buffering, backpressure, and error handling. Actors provide stateful processing. Together they handle both stateless transformations and stateful business logic.

## Key Takeaways

- `Source → Flow → Sink` is a declarative description; `.run()` materializes it
- Backpressure is automatic — fast producers slow down when downstream is busy
- `mapAsync(parallelism)(f)` — run `f` concurrently with bounded parallelism
- `groupedWithin` — batch by count or time window, whichever comes first
- `GraphDSL` enables fan-out (Broadcast) and fan-in (Merge, Zip)
- Streams and actors are composable — use each for what it does best

**Next:** [HTTP with Pekko](/blog/pekko-series-5-http)
