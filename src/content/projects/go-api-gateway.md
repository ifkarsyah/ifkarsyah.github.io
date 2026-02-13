---
title: "Go API Gateway"
description: "A high-performance API gateway built with Go featuring rate limiting, authentication, and request routing."
date: 2024-01-15
tags: ["Go", "Docker", "Redis", "API"]
link: "https://github.com/ifkarsyah/go-api-gateway"
image: ""
featured: true
---

## Overview

A production-ready API gateway built in Go that handles authentication, rate limiting, and intelligent request routing for microservices architectures.

## Features

- **Rate Limiting** – Token bucket algorithm with Redis backend, configurable per client
- **Authentication** – JWT validation with key rotation support
- **Request Routing** – Dynamic routing with load balancing across upstream services
- **Observability** – Prometheus metrics, structured logging, distributed tracing
- **Circuit Breaker** – Automatic failover when upstream services degrade

## Tech Stack

Built with Go's standard `net/http` library for maximum performance, Redis for distributed state, and Docker for containerized deployment.

## Results

- Handles 50,000 requests/second on a single instance
- P99 latency under 5ms for proxied requests
- Zero-downtime configuration reloads via hot reload
