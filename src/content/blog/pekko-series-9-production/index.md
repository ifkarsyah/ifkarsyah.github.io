---
title: "Apache Pekko Series, Part 9: Production Best Practices"
description: "Running Pekko in production: Kafka connectors, OpenTelemetry distributed tracing, health checks, dispatcher tuning, Kubernetes deployment, and migrating from Akka."
pubDate: 2026-03-03
author: "ifkarsyah"
domain: "Streaming"
stack: ["Pekko", "Scala", "Kafka", "Kubernetes"]
image:
  src: ./pekko-series.png
  alt: "Apache Pekko Series — Production Best Practices"
---

Running Pekko in development is straightforward. Running it reliably under production load requires tuning, observability, and operational discipline. This final part covers the practical concerns that do not fit neatly into any single module — the things you learn after the first on-call incident.

## Kafka Connector

Pekko Connectors Kafka integrates Kafka with Pekko Streams. The consumer is a `Source`, the producer is a `Sink` or `Flow` — composable with everything from Part 4.

```sbt
libraryDependencies += "org.apache.pekko" %% "pekko-connectors-kafka" % "1.0.0"
```

### Consumer

```scala
import org.apache.pekko.kafka.scaladsl.Consumer
import org.apache.pekko.kafka.{ConsumerSettings, Subscriptions}
import org.apache.kafka.clients.consumer.ConsumerConfig
import org.apache.kafka.common.serialization.StringDeserializer

val consumerSettings = ConsumerSettings(system, new StringDeserializer, new StringDeserializer)
  .withBootstrapServers("kafka:9092")
  .withGroupId("my-consumer-group")
  .withProperty(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest")

Consumer
  .committableSource(consumerSettings, Subscriptions.topics("orders"))
  .mapAsync(4) { msg =>
    processOrder(msg.record.value())
      .map(_ => msg.committableOffset)
  }
  .via(Committer.flow(CommitterSettings(system)))
  .runWith(Sink.ignore)
```

`committableSource` gives you control over when offsets are committed — commit after processing, not before. This gives you at-least-once delivery guarantees.

### Producer

```scala
import org.apache.pekko.kafka.scaladsl.Producer
import org.apache.pekko.kafka.ProducerSettings
import org.apache.kafka.clients.producer.ProducerRecord

val producerSettings = ProducerSettings(system, new StringSerializer, new StringSerializer)
  .withBootstrapServers("kafka:9092")

Source(events)
  .map(e => new ProducerRecord[String, String]("output-topic", e.key, e.toJson))
  .runWith(Producer.plainSink(producerSettings))
```

## Distributed Tracing with OpenTelemetry

Pekko does not ship a tracing integration, but you can instrument actor message passing with the OpenTelemetry SDK:

```sbt
libraryDependencies += "io.opentelemetry" % "opentelemetry-sdk" % "1.36.0"
```

The pattern: extract the trace context from incoming messages and inject it into outgoing ones. A common approach is to wrap all command types with an optional `TraceContext`:

```scala
case class TracedCommand[T](command: T, traceContext: Map[String, String])

// On receive: restore the span
val parentContext = W3CTraceContextPropagator.getInstance()
  .extract(Context.current(), msg.traceContext, MapTextMapGetter)
val span = tracer.spanBuilder("process-command").setParent(parentContext).startSpan()

try {
  processCommand(msg.command)
} finally {
  span.end()
}
```

For HTTP, pekko-http integrates cleanly with OpenTelemetry's Java agent — attach the agent to the JVM and HTTP spans are captured automatically.

## Health Checks

Expose liveness and readiness endpoints using pekko-management:

```sbt
libraryDependencies += "org.apache.pekko" %% "pekko-management" % "1.1.0"
```

```scala
import org.apache.pekko.management.scaladsl.PekkoManagement

PekkoManagement(system).start()
```

This exposes:
- `GET /alive` — liveness (is the JVM running?)
- `GET /ready` — readiness (is the cluster formed and the app ready?)

Kubernetes liveness/readiness probes:

```yaml
livenessProbe:
  httpGet:
    path: /alive
    port: 8558
  initialDelaySeconds: 30
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /ready
    port: 8558
  initialDelaySeconds: 10
  periodSeconds: 5
```

## Dispatcher Tuning

Dispatchers are the thread pools that run actors. The default dispatcher is a fork-join pool suitable for CPU-bound work. For blocking I/O (database calls, file operations), use a dedicated dispatcher to prevent blocking the main pool:

```hocon
blocking-dispatcher {
  type       = Dispatcher
  executor   = "thread-pool-executor"
  thread-pool-executor {
    fixed-pool-size = 32
  }
  throughput = 1
}
```

```scala
import org.apache.pekko.actor.typed.DispatcherSelector

context.spawn(
  BlockingDatabaseActor(),
  "db-worker",
  DispatcherSelector.fromConfig("blocking-dispatcher")
)
```

Never block in an actor on the default dispatcher. One blocked thread starves other actors sharing that pool.

## Kubernetes Deployment

For dynamic cluster formation in Kubernetes, use the Kubernetes API discovery:

```sbt
libraryDependencies += "org.apache.pekko" %% "pekko-management-cluster-bootstrap" % "1.1.0"
libraryDependencies += "org.apache.pekko" %% "pekko-discovery-kubernetes-api"     % "1.1.0"
```

```hocon
pekko {
  management.cluster.bootstrap.contact-point-discovery {
    service-name   = "my-pekko-app"
    discovery-method = kubernetes-api
  }
}
```

```scala
ClusterBootstrap(system).start()
PekkoManagement(system).start()
```

Pods find each other via the Kubernetes API — no hardcoded seed nodes, no external service registry.

## Migrating from Akka

Pekko is a near-identical fork. The migration is mostly a find-and-replace:

| Akka | Pekko |
|------|-------|
| `akka.*` imports | `org.apache.pekko.*` |
| `com.typesafe.akka` group IDs | `org.apache.pekko` |
| `ActorSystem[T]` | Same API |
| `akka.*` config keys | `pekko.*` |

```bash
# Replace package names
find src -name "*.scala" | xargs sed -i 's/import akka\./import org.apache.pekko./g'

# Replace config keys in .conf files
find . -name "*.conf" | xargs sed -i 's/^akka\./pekko./g'
```

Most projects migrate in a day. The APIs are source-compatible — behavior is identical.

## Key Takeaways

- Pekko Connectors Kafka provides backpressure-aware consumer and producer Streams
- Use `committableSource` + manual commit for at-least-once Kafka consumption
- OpenTelemetry: propagate trace context through message envelopes; use the Java agent for HTTP
- Expose `/alive` and `/ready` via pekko-management for Kubernetes health probes
- Use dedicated dispatchers for blocking I/O — never block on the default dispatcher
- Kubernetes API discovery eliminates hardcoded seed nodes in containerized deployments
- Migrating from Akka is mostly import path and config key renaming

---

This concludes the Apache Pekko Series. You now have the building blocks for concurrent, distributed, and resilient systems on the JVM — from single-node actors through event-sourced persistence, reactive streams, HTTP and gRPC APIs, multi-node clustering, CQRS projections, and production operation. The rest is practice.
