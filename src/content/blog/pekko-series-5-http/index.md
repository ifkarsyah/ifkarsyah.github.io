---
title: "Apache Pekko Series, Part 5: HTTP with Pekko"
description: "Build REST APIs with pekko-http's routing DSL. HTTP server setup, route composition, request and response marshalling, and integrating HTTP endpoints with an actor system."
pubDate: 2026-02-27
author: "ifkarsyah"
domain: "Streaming"
stack: ["Pekko", "Scala"]
image:
  src: ./pekko-series.png
  alt: "Apache Pekko Series — HTTP with Pekko"
---

HTTP is how most services talk to the world. Pekko HTTP is not a framework — it is a toolkit. There is no dependency injection container, no magic annotations, no hidden conventions. Just a routing DSL, a streaming HTTP layer built on Pekko Streams, and full control over every request and response.

## Setup

```sbt
val PekkoHttpVersion = "1.1.0"

libraryDependencies ++= Seq(
  "org.apache.pekko" %% "pekko-http"            % PekkoHttpVersion,
  "org.apache.pekko" %% "pekko-http-spray-json" % PekkoHttpVersion,  // JSON support
  "org.apache.pekko" %% "pekko-stream"          % PekkoVersion
)
```

## The Routing DSL

Routes are built by composing **directives** — functions that either match a request (and handle it) or reject it (passing to the next alternative):

```scala
import org.apache.pekko.http.scaladsl.server.Directives._
import org.apache.pekko.http.scaladsl.server.Route

val route: Route =
  pathPrefix("api" / "v1") {
    concat(
      // GET /api/v1/items
      path("items") {
        get {
          complete("[]")
        }
      },
      // GET /api/v1/items/:id
      path("items" / Segment) { id =>
        get {
          complete(s"""{"id": "$id"}""")
        }
      },
      // POST /api/v1/items
      path("items") {
        post {
          entity(as[String]) { body =>
            complete(StatusCodes.Created, body)
          }
        }
      }
    )
  }
```

Directives compose with `concat` (try alternatives), `~` (alias for concat), and nesting (AND semantics). If a directive rejects, the next alternative is tried. If all alternatives reject, a 404 or 405 is returned.

## Starting the Server

```scala
import org.apache.pekko.actor.typed.ActorSystem
import org.apache.pekko.actor.typed.scaladsl.Behaviors
import org.apache.pekko.http.scaladsl.Http

object Main extends App {
  implicit val system: ActorSystem[Nothing] =
    ActorSystem(Behaviors.empty, "pekko-http-server")
  implicit val ec = system.executionContext

  val bindingFuture = Http().newServerAt("0.0.0.0", 8080).bind(route)

  bindingFuture.foreach { binding =>
    println(s"Server online at http://localhost:8080/")
  }
}
```

## JSON Marshalling

Pekko HTTP uses **marshallers** to convert between Scala types and HTTP entities. With `pekko-http-spray-json`:

```scala
import org.apache.pekko.http.scaladsl.marshallers.sprayjson.SprayJsonSupport._
import spray.json._
import spray.json.DefaultJsonProtocol._

case class Item(id: String, name: String, price: Double)

// Derive JSON format automatically
implicit val itemFormat: RootJsonFormat[Item] = jsonFormat3(Item)

val route: Route =
  path("items") {
    get {
      // Scala value → JSON response automatically
      complete(Item("1", "Widget", 9.99))
    } ~
    post {
      // JSON request body → Scala value automatically
      entity(as[Item]) { item =>
        println(s"Received: $item")
        complete(StatusCodes.Created, item)
      }
    }
  }
```

The `complete(item)` call uses the implicit `itemFormat` to serialize to `application/json`. `entity(as[Item])` uses it to deserialize from the request body.

## Integrating with Actors

The most common pattern is the **ask pattern** — the HTTP handler asks an actor for a result and returns the future as the response:

```scala
import org.apache.pekko.actor.typed.{ActorRef, ActorSystem}
import org.apache.pekko.actor.typed.scaladsl.AskPattern._
import org.apache.pekko.util.Timeout

implicit val timeout: Timeout = 5.seconds

// Assume we have a registry actor
val registry: ActorRef[ItemRegistry.Command] = ...

val route: Route =
  path("items" / Segment) { id =>
    get {
      val responseFuture: Future[Option[Item]] =
        registry.ask(ItemRegistry.FindById(id, _))

      onSuccess(responseFuture) {
        case Some(item) => complete(item)
        case None       => complete(StatusCodes.NotFound)
      }
    }
  }
```

`onSuccess` unwraps a `Future` and runs the inner route with the value. If the future fails (e.g., actor timeout), it returns a 500 automatically.

## Error Handling

Use `handleExceptions` or `handleRejections` to provide consistent error responses:

```scala
import org.apache.pekko.http.scaladsl.server.ExceptionHandler

implicit val exceptionHandler: ExceptionHandler = ExceptionHandler {
  case ex: IllegalArgumentException =>
    complete(StatusCodes.BadRequest, ex.getMessage)
  case ex: Exception =>
    complete(StatusCodes.InternalServerError, "Internal error")
}

val route: Route = handleExceptions(exceptionHandler) {
  // your routes here
}
```

## Key Takeaways

- Routes are composed from directives — each directive either matches or rejects
- `concat` / `~` try alternatives; nesting adds AND conditions
- `complete(value)` uses implicit marshallers to serialize the response
- `entity(as[T])` uses implicit unmarshallers to deserialize the request body
- The ask pattern (`actorRef.ask`) bridges HTTP handlers to actors cleanly
- `onSuccess(future)` unwraps a Future inside a route without blocking

**Next:** [gRPC with Pekko](/blog/pekko-series-6-grpc)
