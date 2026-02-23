---
title: "Apache Pekko Series, Part 6: gRPC with Pekko"
description: "Protocol Buffers, generated Pekko service stubs, server and client setup, and bidirectional streaming. When to use gRPC instead of REST and how to run both side by side."
pubDate: 2026-02-28
author: "ifkarsyah"
domain: "Streaming"
stack: ["Pekko", "Scala"]
image:
  src: ./pekko-series.png
  alt: "Apache Pekko Series — gRPC with Pekko"
---

REST over JSON is a fine default, but it has overhead: JSON is verbose, parsing is slow, and the contract between client and server is implicit. **gRPC** solves all three: it uses Protocol Buffers (binary, compact, schema-first), HTTP/2 (multiplexed, lower latency), and generates client/server stubs from the `.proto` file.

`pekko-grpc` generates Pekko Streams-based server and client code directly from your proto definitions.

## When to Use gRPC

| Concern | REST + JSON | gRPC |
|---------|-------------|------|
| Payload size | Larger (text) | Smaller (binary) |
| Schema contract | Implicit | Explicit (proto) |
| Streaming | Awkward (SSE/WS) | First-class (4 modes) |
| Browser support | Native | Needs grpc-web |
| Human-readable | Yes | No (needs tooling) |
| Service mesh | Any | Preferred |

gRPC shines for internal service-to-service communication, high-throughput APIs, and anything that needs streaming.

## Setup

```sbt
// project/plugins.sbt
addSbtPlugin("org.apache.pekko" % "pekko-grpc-sbt-plugin" % "1.1.1")

// build.sbt
enablePlugins(PekkoGrpcPlugin)

libraryDependencies ++= Seq(
  "org.apache.pekko" %% "pekko-grpc-runtime" % "1.1.1",
  "org.apache.pekko" %% "pekko-stream"       % PekkoVersion
)
```

## Define the Proto

```protobuf
// src/main/protobuf/greeter.proto
syntax = "proto3";

option java_package = "com.example.greeter";

package helloworld;

service Greeter {
  // Unary RPC
  rpc SayHello (HelloRequest) returns (HelloReply) {}

  // Server streaming RPC
  rpc SayHellos (HelloRequest) returns (stream HelloReply) {}

  // Client streaming RPC
  rpc RecordHellos (stream HelloRequest) returns (HelloReply) {}

  // Bidirectional streaming RPC
  rpc SayHelloToAll (stream HelloRequest) returns (stream HelloReply) {}
}

message HelloRequest { string name = 1; }
message HelloReply   { string message = 1; }
```

Run `sbt compile` and pekko-grpc generates:
- `GreeterService` — the trait your server implements
- `GreeterClient` — the Pekko Streams-based client

## Implement the Server

```scala
import org.apache.pekko.stream.scaladsl.Source
import helloworld.{GreeterService, HelloReply, HelloRequest}

class GreeterServiceImpl(implicit val system: ActorSystem[_])
    extends GreeterService {

  // Unary: one request → one response
  override def sayHello(request: HelloRequest): Future[HelloReply] =
    Future.successful(HelloReply(s"Hello, ${request.name}!"))

  // Server streaming: one request → many responses
  override def sayHellos(request: HelloRequest): Source[HelloReply, NotUsed] =
    Source(1 to 5).map(i => HelloReply(s"Hello #$i, ${request.name}!"))

  // Client streaming: many requests → one response
  override def recordHellos(in: Source[HelloRequest, NotUsed]): Future[HelloReply] =
    in.runFold(List.empty[String])(_ :+ _.name)
      .map(names => HelloReply(s"Recorded: ${names.mkString(", ")}"))

  // Bidirectional streaming: many requests → many responses
  override def sayHelloToAll(in: Source[HelloRequest, NotUsed]): Source[HelloReply, NotUsed] =
    in.map(req => HelloReply(s"Hello, ${req.name}!"))
}
```

The streaming RPCs use plain Pekko Streams `Source` — the same API you already know from Part 4.

## Start the gRPC Server

```scala
import org.apache.pekko.http.scaladsl.Http
import org.apache.pekko.grpc.scaladsl.ServiceHandler
import helloworld.GreeterServiceHandler

object GrpcServer extends App {
  implicit val system: ActorSystem[Nothing] =
    ActorSystem(Behaviors.empty, "grpc-server")
  implicit val ec = system.executionContext

  val service = GreeterServiceHandler(new GreeterServiceImpl())

  Http()
    .newServerAt("0.0.0.0", 8080)
    .bind(service)
    .foreach(_ => println("gRPC server running on :8080"))
}
```

## Use the Client

```scala
import helloworld.{GreeterClient, HelloRequest}
import org.apache.pekko.grpc.GrpcClientSettings

val clientSettings = GrpcClientSettings.connectToServiceAt("localhost", 8080)
val client = GreeterClient(clientSettings)

// Unary call
val reply: Future[HelloReply] = client.sayHello(HelloRequest("World"))
reply.foreach(r => println(r.message))

// Server streaming
client.sayHellos(HelloRequest("World"))
  .runForeach(reply => println(reply.message))
```

## Combining gRPC and HTTP

Both use HTTP/2 under the hood. You can serve gRPC and REST on the same port:

```scala
import org.apache.pekko.grpc.scaladsl.WebHandler

val grpcHandler  = GreeterServiceHandler(new GreeterServiceImpl())
val httpRoute    = myHttpRoute

// Route gRPC requests to the gRPC handler, others to HTTP
val combinedHandler = WebHandler.grpcWebHandler(grpcHandler)

Http()
  .newServerAt("0.0.0.0", 8080)
  .bind(ServiceHandler.concatOrNotFound(grpcHandler, httpRoute))
```

## Key Takeaways

- Proto defines the contract; pekko-grpc generates both server trait and client
- Four RPC modes: unary, server streaming, client streaming, bidirectional streaming
- Streaming RPCs use regular Pekko Streams `Source` — composable with the rest of your pipeline
- gRPC and HTTP can coexist on the same port with `ServiceHandler.concatOrNotFound`
- Binary encoding + HTTP/2 multiplexing makes gRPC significantly faster than REST for internal calls
- Use gRPC for inter-service communication; REST for public APIs consumed by browsers

**Next:** [Clustering & Distributed Actors](/blog/pekko-series-7-clustering)
