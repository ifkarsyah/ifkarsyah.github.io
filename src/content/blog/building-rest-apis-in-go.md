---
title: "Building REST APIs in Go: A Practical Guide"
description: "A hands-on walkthrough of building production-ready REST APIs with Go, covering routing, middleware, error handling, and testing."
pubDate: 2024-01-10
author: "ifkarsyah"
tags: ["Go", "API", "Backend"]
image:
  url: "https://images.unsplash.com/photo-1555066931-4365d14bab8c?w=800"
  alt: "Code on a screen"
---

## Introduction

Go is one of the best languages for building REST APIs. Its standard library is powerful enough for production use, compilation is fast, and the resulting binaries are tiny and portable.

In this guide, I'll walk through building a complete REST API from scratch.

## Project Structure

```
api/
├── cmd/
│   └── server/
│       └── main.go
├── internal/
│   ├── handlers/
│   ├── middleware/
│   ├── models/
│   └── store/
├── go.mod
└── go.sum
```

## Basic Handler

```go
package handlers

import (
    "encoding/json"
    "net/http"
)

type UserHandler struct {
    store UserStore
}

func (h *UserHandler) GetUser(w http.ResponseWriter, r *http.Request) {
    id := r.PathValue("id")
    user, err := h.store.GetByID(r.Context(), id)
    if err != nil {
        http.Error(w, "user not found", http.StatusNotFound)
        return
    }
    json.NewEncoder(w).Encode(user)
}
```

## Middleware

Middleware in Go is just a function that wraps an `http.Handler`:

```go
func LoggingMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        start := time.Now()
        next.ServeHTTP(w, r)
        log.Printf("%s %s %v", r.Method, r.URL.Path, time.Since(start))
    })
}
```

## Conclusion

Go's standard library gives you everything you need for a solid REST API. Start simple, add complexity only when needed.
