---
title: "Consistent Hashing Explained"
description: "Understanding consistent hashing — the algorithm behind distributed caches, CDNs, and database sharding."
pubDate: 2023-11-20
author: "ifkarsyah"
tags: ["Distributed Systems", "Algorithms"]
image:
  url: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=800"
  alt: "Server room"
---

## The Problem

Imagine you have a cache cluster with N servers. The naive approach to distribute keys is:

```
server = hash(key) % N
```

This works fine until you add or remove a server. Suddenly almost every key maps to a different server, causing a massive cache miss storm.

## Consistent Hashing to the Rescue

Consistent hashing solves this by placing both servers and keys on a virtual "ring." When you look up a key, you find its position on the ring and walk clockwise to the first server.

When a server is added or removed, only keys in the adjacent segment need to be remapped — typically `1/N` of all keys.

## Virtual Nodes

A basic ring has a problem: uneven distribution. If servers happen to cluster together on the ring, some get much more traffic than others.

The solution is virtual nodes: each physical server gets mapped to multiple positions on the ring. With 150 virtual nodes per server, distribution becomes very uniform.

```go
func (r *Ring) Add(server string) {
    for i := 0; i < r.replicas; i++ {
        hash := r.hash(fmt.Sprintf("%s-%d", server, i))
        r.ring[hash] = server
        r.sorted = append(r.sorted, hash)
    }
    sort.Slice(r.sorted, func(i, j int) bool {
        return r.sorted[i] < r.sorted[j]
    })
}
```

## Real World Usage

- **Amazon DynamoDB** – Partitions data across nodes
- **Apache Cassandra** – Distributes data with token-based consistent hashing
- **Nginx** – Consistent hashing for upstream load balancing
- **CDN providers** – Route requests to the nearest edge node

Consistent hashing is one of those foundational ideas worth truly understanding — it appears everywhere in distributed systems.
