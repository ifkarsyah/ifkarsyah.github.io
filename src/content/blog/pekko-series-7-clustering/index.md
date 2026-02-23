---
title: "Apache Pekko Series, Part 7: Clustering & Distributed Actors"
description: "Running Pekko across multiple JVMs. Cluster membership, the gossip protocol, cluster sharding for stateful actors, and singleton actors — all with practical configuration examples."
pubDate: 2026-03-01
author: "ifkarsyah"
domain: "Streaming"
stack: ["Pekko", "Scala"]
image:
  src: ./pekko-series.png
  alt: "Apache Pekko Series — Clustering & Distributed Actors"
---

A single JVM can handle a lot — but not everything. Eventually you need more memory than one machine can provide, more CPU than one process can use, or fault tolerance that survives a machine failure. Pekko Cluster lets you distribute your actor system across multiple JVM instances while keeping the same actor model and message-passing API.

## How Clusters Work

A Pekko cluster is a set of nodes (JVM processes) that form a group. Membership is managed by a **gossip protocol**: each node periodically shares its view of the cluster with a random subset of other nodes. Eventually, all nodes converge on the same membership state.

```
Node A ──gossip──► Node B
Node A ◄──gossip── Node C
Node B ──gossip──► Node C

All nodes eventually agree:
  - Who is in the cluster
  - Which nodes are reachable
  - Who is the current leader
```

The **leader** is not a master node — it is a deterministically elected coordinator (based on sorted address) that handles membership transitions (joining, leaving, unreachable). If the leader node fails, a new one is elected automatically.

## Configuration

Add the cluster dependency:

```sbt
libraryDependencies += "org.apache.pekko" %% "pekko-cluster-typed" % PekkoVersion
```

`application.conf`:

```hocon
pekko {
  actor.provider = cluster

  remote.artery {
    canonical.hostname = "127.0.0.1"
    canonical.port     = 2551
  }

  cluster {
    seed-nodes = [
      "pekko://MySystem@127.0.0.1:2551",
      "pekko://MySystem@127.0.0.1:2552"
    ]
    downing-provider-class = "org.apache.pekko.cluster.sbr.SplitBrainResolverProvider"
  }
}
```

Seed nodes are the initial contact points. A new node contacts any seed node to join the cluster. In production, use dynamic seed node discovery (Kubernetes, Consul, etc.) instead of hardcoded IPs.

## Cluster Events

React to membership changes by subscribing to cluster events:

```scala
import org.apache.pekko.cluster.typed.{Cluster, Subscribe}
import org.apache.pekko.cluster.ClusterEvent._

object ClusterListener {
  def apply(): Behavior[MemberEvent] =
    Behaviors.setup { context =>
      val cluster = Cluster(context.system)
      cluster.subscriptions ! Subscribe(context.self, classOf[MemberEvent])

      Behaviors.receiveMessage {
        case MemberUp(member) =>
          context.log.info("Node joined: {}", member.address)
          Behaviors.same
        case MemberRemoved(member, _) =>
          context.log.info("Node left: {}", member.address)
          Behaviors.same
        case _ =>
          Behaviors.same
      }
    }
}
```

## Cluster Sharding

The key pattern for distributing stateful actors. Cluster sharding spreads actors (called **entities**) across cluster nodes. Each entity has a unique ID. Pekko routes messages to the right node automatically — the sender does not need to know where the entity lives.

```scala
import org.apache.pekko.cluster.sharding.typed.scaladsl._

// Define the entity type
val TypeKey = EntityTypeKey[BankAccount.Command]("BankAccount")

// Start sharding (call on every node)
val sharding = ClusterSharding(system)
val shardRegion: ActorRef[ShardingEnvelope[BankAccount.Command]] =
  sharding.init(Entity(TypeKey)(ctx => BankAccount(ctx.entityId)))

// Send a message to any account — sharding routes it to the right node
shardRegion ! ShardingEnvelope("account-42", BankAccount.Deposit(100, replyTo))
```

Or use the `EntityRef` API for type-safe targeting:

```scala
val account: EntityRef[BankAccount.Command] =
  sharding.entityRefFor(TypeKey, "account-42")

account ! BankAccount.Deposit(100, replyTo)
```

Sharding guarantees that at most one instance of each entity exists in the cluster at any time. If a node fails, its entities are restarted on surviving nodes.

## Cluster Singleton

When you need exactly one instance of an actor across the whole cluster — a leader, a scheduler, a unique resource manager:

```scala
import org.apache.pekko.cluster.typed.{ClusterSingleton, SingletonActor}

val singleton = ClusterSingleton(system)
val proxy: ActorRef[SchedulerActor.Command] =
  singleton.init(SingletonActor(SchedulerActor(), "scheduler"))

// Send messages via the proxy — it routes to wherever the singleton lives
proxy ! SchedulerActor.Tick
```

The singleton migrates automatically when the node it runs on fails. There is a brief gap (configurable) during migration when the singleton is unavailable.

## Split Brain and Downing

When network partitions occur, two sides of a cluster may stop seeing each other. Without resolution, both sides might declare themselves the active cluster — leading to two singletons, split data, and corruption. The **Split Brain Resolver** (`SBR`) automatically downing the minority side:

```hocon
pekko.cluster.downing-provider-class =
  "org.apache.pekko.cluster.sbr.SplitBrainResolverProvider"

pekko.cluster.split-brain-resolver {
  active-strategy = keep-majority
}
```

`keep-majority` keeps the partition with more nodes and downs the minority. Never run a production cluster without an SBR or equivalent.

## Key Takeaways

- Gossip protocol maintains membership without a central coordinator
- Seed nodes are contact points for joining — use dynamic discovery in production
- Cluster sharding distributes stateful entities across nodes; routing is automatic
- `EntityRef` gives you a type-safe handle to a sharded entity by ID
- Cluster singleton ensures one instance cluster-wide; migrates on node failure
- Always configure a Split Brain Resolver to handle network partitions safely

**Next:** [CQRS & Projections](/blog/pekko-series-8-cqrs-projection)
