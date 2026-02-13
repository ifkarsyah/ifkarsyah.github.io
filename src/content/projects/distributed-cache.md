---
title: "Distributed Cache Library"
description: "A consistent-hashing based distributed cache library for Go with automatic rebalancing and fault tolerance."
date: 2023-09-10
tags: ["Go", "Distributed Systems", "Open Source"]
link: "https://github.com/ifkarsyah/distributed-cache"
image: ""
featured: true
---

## Overview

A distributed in-memory cache library implementing consistent hashing for data distribution across multiple nodes, with automatic rebalancing when nodes join or leave the cluster.

## Features

- **Consistent Hashing** – Minimal data redistribution when cluster topology changes
- **Replication** – Configurable replication factor for fault tolerance
- **Auto-discovery** – Nodes discover each other via gossip protocol
- **TTL Support** – Per-key time-to-live with lazy expiration
- **Persistence** – Optional AOF (Append-Only File) log for crash recovery

## Architecture

Uses a virtual node ring for hash distribution, gossip protocol for membership, and Raft consensus for leader election in the control plane.

## Usage

```go
cache := dcache.New(dcache.Options{
    Replicas: 3,
    TTL:      5 * time.Minute,
})

cache.Set("key", "value")
val, ok := cache.Get("key")
```
