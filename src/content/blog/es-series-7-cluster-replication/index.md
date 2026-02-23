---
title: "Elasticsearch Internals Series, Part 7: Cluster Architecture & Replication"
description: "Node roles, primary vs replica shards, the write path from primary to replicas, split-brain prevention with quorum, and observing cluster recovery under node failure."
pubDate: 2026-04-13
author: "ifkarsyah"
domain: "Search"
stack: ["Elasticsearch"]
image:
  src: ./es-series.png
  alt: "Elasticsearch Cluster Architecture"
---

A single Elasticsearch node is a single point of failure. The cluster model — multiple nodes coordinating over the network — is what gives Elasticsearch availability, durability, and horizontal scale. But distribution introduces new failure modes: split-brain, unassigned shards, primary failover.

Understanding how the cluster works lets you design for failure instead of being surprised by it.

## Node Roles

Every node in an Elasticsearch cluster can play one or more roles:

```
┌─────────────────────────────────────────────────────────┐
│                    Elasticsearch Cluster                 │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │ Master Node  │  │  Data Node   │  │  Data Node   │  │
│  │ (eligible)   │  │  (hot)       │  │  (warm)      │  │
│  └──────────────┘  └──────────────┘  └──────────────┘  │
│                                                          │
│  ┌──────────────┐  ┌──────────────┐                     │
│  │ Ingest Node  │  │ Coordinating │                     │
│  │              │  │ Node (only)  │                     │
│  └──────────────┘  └──────────────┘                     │
└─────────────────────────────────────────────────────────┘
```

| Role | Responsibility | `elasticsearch.yml` |
|---|---|---|
| `master` | Cluster state, shard allocation, index/node management | `node.roles: [master]` |
| `data` | Store shards, execute search/index | `node.roles: [data]` |
| `data_content` | Persistent data (not time-series) | `node.roles: [data_content]` |
| `data_hot` | Latest, most-queried time-series data | `node.roles: [data_hot]` |
| `data_warm` | Older time-series data, read-mostly | `node.roles: [data_warm]` |
| `data_cold` | Rarely accessed, cheap storage | `node.roles: [data_cold]` |
| `ingest` | Run ingest pipelines before indexing | `node.roles: [ingest]` |
| `coordinating` (only) | Route requests, no roles set | `node.roles: []` |

For small clusters (< 3 nodes), nodes typically have all roles. For large production clusters, separate master-eligible nodes (3 dedicated masters), data nodes, and optionally coordinating nodes (load balancer layer).

## The Elected Master

Only one node is the **elected master** at a time. It's responsible for:
- Maintaining the **cluster state** (which nodes exist, which shards are on which nodes, index mappings, settings)
- Allocating shards to nodes
- Publishing cluster state changes

The cluster state is not stored in Elasticsearch indexes — it's maintained in memory on the elected master and replicated to all nodes.

**Master election** uses a quorum-based algorithm (Raft-derived in ES 7.x+):

- A master-eligible node wins election by getting votes from a majority of master-eligible nodes
- This prevents split-brain: in a 3-master-eligible cluster, a partition can only form a quorum on one side

```yaml
# elasticsearch.yml — for a 3-master-eligible-node cluster
cluster.initial_master_nodes: ["node-1", "node-2", "node-3"]
```

Check who the current master is:

```bash
curl -X GET "localhost:9200/_cat/master?v"
```

## Primary and Replica Shards

Each index has `number_of_primary_shards` primary shards and `number_of_replicas` replica copies per primary.

```
Index "products" (3 primary shards, 1 replica each):

Node 1:  Primary 0  |  Replica 1
Node 2:  Primary 1  |  Replica 2
Node 3:  Primary 2  |  Replica 0
```

Note: A primary and its replica are never on the same node. If Node 1 fails, Replica 0 (on Node 3) is promoted to primary.

**Replicas serve two purposes:**
1. **Redundancy**: If the primary shard's node fails, a replica is promoted to primary
2. **Read throughput**: Searches can be served by either primary or replica — adds read capacity

## The Write Path

When a document is indexed:

```
Client
  │
  │  PUT /products/_doc/42  { "title": "..." }
  ▼
Coordinating Node
  │
  │ 1. Route: shard = hash("42") % 3 = shard 1
  │ 2. Forward to PRIMARY shard 1's node
  ▼
Primary Shard 1 (on Node 2)
  │
  │ 3. Index document locally (write to translog, index buffer)
  │ 4. Forward to all replicas IN PARALLEL
  │
  ├──────────────────────┐
  ▼                      ▼
Replica of Shard 1     (other replicas)
  │
  │ 5. Index locally
  │ 6. Acknowledge to primary
  │
  ▼
Primary Shard 1
  │
  │ 7. All replicas acknowledged
  │ 8. Acknowledge to coordinating node
  ▼
Coordinating Node
  │
  ▼
Client  ← HTTP 200 { "result": "created" }
```

The client only gets a success response after **all active shard copies** (primary + all replicas) have written the document. This is the default `wait_for_active_shards: 1` (just primary must acknowledge).

**`wait_for_active_shards`:**

```bash
# Wait for all replicas before acknowledging
curl -X PUT "localhost:9200/products/_doc/1?wait_for_active_shards=all" -H 'Content-Type: application/json' -d '
{ "title": "Laptop" }'

# Wait for quorum (majority) of shard copies
curl -X PUT "localhost:9200/products/_doc/1?wait_for_active_shards=2" -H 'Content-Type: application/json' -d '
{ "title": "Laptop" }'
```

Setting `wait_for_active_shards=all` means the write fails if any replica is unavailable. More durable but less available during node failures.

## Node Failure and Shard Recovery

When a data node fails:

```
Before failure:
  Node 1: Primary 0  |  Replica 1
  Node 2: Primary 1  |  Replica 2   ← Node 2 dies
  Node 3: Primary 2  |  Replica 0

After failure detected by master:
  Node 1: Primary 0  |  Replica 1  |  NEW Primary 1 (promoted from Replica 1 on Node 1)
  Node 3: Primary 2  |  Replica 0  |  NEW Replica 1 (recovering from Node 1's primary)
```

Steps:
1. Master detects node failure (heartbeat timeout)
2. Master promotes a replica to primary for each orphaned primary
3. Master allocates new replicas on surviving nodes to restore the configured replica count
4. New replicas sync from their new primary (translog replay + segment copy)

**Cluster health transitions:**

```
GREEN:   All primary AND replica shards assigned and active
YELLOW:  All primary shards active, but some replicas unassigned
RED:     At least one primary shard unassigned (data unavailable)
```

A single-node cluster with `number_of_replicas: 1` is always YELLOW — replicas can't be assigned to the same node as the primary.

## Hands-On: Observing Cluster Health

Set up a 2-node cluster (adjust the Docker Compose from Part 0):

```yaml
version: '3.8'
services:
  es01:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.12.0
    environment:
      - node.name=es01
      - cluster.name=es-cluster
      - cluster.initial_master_nodes=es01,es02
      - discovery.seed_hosts=es02
      - xpack.security.enabled=false
      - ES_JAVA_OPTS=-Xms512m -Xmx512m
    ports: ["9200:9200"]

  es02:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.12.0
    environment:
      - node.name=es02
      - cluster.name=es-cluster
      - cluster.initial_master_nodes=es01,es02
      - discovery.seed_hosts=es01
      - xpack.security.enabled=false
      - ES_JAVA_OPTS=-Xms512m -Xmx512m
    ports: ["9201:9200"]
```

```bash
docker compose up -d

# Check cluster health
curl -X GET "localhost:9200/_cluster/health?pretty"
# → status: "green" (both nodes up, replicas assigned)

# Check shard distribution
curl -X GET "localhost:9200/_cat/shards?v"
```

Simulate node failure:

```bash
# Kill es02
docker compose stop es02

# Observe health change
curl -X GET "localhost:9200/_cluster/health?pretty"
# → status: "yellow" (replicas lost, but primaries promoted)

# Watch recovery
watch -n 1 "curl -s localhost:9200/_cat/shards?v"
```

Restart the node:

```bash
docker compose start es02

# es02 rejoins, receives shard sync
curl -X GET "localhost:9200/_cluster/health?pretty"
# → status transitions back to "green"

# Time to recover
curl -X GET "localhost:9200/_cat/recovery?v&active_only=true"
```

## Cluster State and Allocation

Check detailed allocation:

```bash
curl -X GET "localhost:9200/_cluster/allocation/explain?pretty" -H 'Content-Type: application/json' -d '
{ "index": "products", "shard": 0, "primary": false }'
```

This tells you exactly why an unassigned shard can't be placed: not enough nodes, disk watermark exceeded, allocation filter mismatch, etc.

**Manual reroute** (last resort for stuck shards):

```bash
curl -X POST "localhost:9200/_cluster/reroute" -H 'Content-Type: application/json' -d '
{
  "commands": [
    {
      "allocate_stale_primary": {
        "index": "products",
        "shard": 0,
        "node": "es01",
        "accept_data_loss": true   ← acknowledge potential data loss
      }
    }
  ]
}'
```

## Disk Watermarks

Elasticsearch will stop writing to a node when its disk fills up:

```bash
curl -X GET "localhost:9200/_cluster/settings?include_defaults=true&filter_path=**.watermark"
```

Default watermarks:
- `cluster.routing.allocation.disk.watermark.low`: 85% — no new shards allocated here
- `cluster.routing.allocation.disk.watermark.high`: 90% — existing shards relocated off
- `cluster.routing.allocation.disk.watermark.flood_stage`: 95% — index made read-only

Adjust for your environment:

```bash
curl -X PUT "localhost:9200/_cluster/settings" -H 'Content-Type: application/json' -d '
{
  "transient": {
    "cluster.routing.allocation.disk.watermark.low": "90%",
    "cluster.routing.allocation.disk.watermark.high": "95%",
    "cluster.routing.allocation.disk.watermark.flood_stage": "97%"
  }
}'
```

## Key Takeaways

- **One elected master** manages cluster state, shard allocation, and node membership. Dedicated master nodes prevent data node work from affecting master stability.
- **Primary writes, then replicates.** The client gets an acknowledgment only after `wait_for_active_shards` copies have written.
- **Replica on the same node as primary is prevented** by the cluster. A 1-replica index on 1 node = YELLOW forever.
- **Node failure → master promotes replicas to primaries, then allocates new replicas.** Recovery time depends on how much translog replay and data transfer is needed.
- **`_cluster/allocation/explain`** is the definitive tool for diagnosing unassigned shards.
- **Disk watermarks** cause read-only indexes when nodes fill up. Monitor disk usage proactively.

## Next Steps

The final piece: what actually happens to a write from the moment you send it until it's safely on disk? The translog, the indexing buffer, and the flush cycle are Elasticsearch's durability mechanism — analogous to a write-ahead log.

---

**Part 7 complete. Next: [Write Path & Translog](/blog/es-series-8-write-path/)**
