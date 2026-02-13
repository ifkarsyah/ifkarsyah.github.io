---
title: "Go Concurrency Patterns I Use Every Day"
description: "Practical goroutine patterns for real-world Go programs: worker pools, fan-out/fan-in, context cancellation."
pubDate: 2023-08-05
author: "ifkarsyah"
tags: ["Go", "Concurrency"]
image:
  url: "https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=800"
  alt: "Abstract code visualization"
---

## Worker Pool

The most useful pattern for CPU or I/O bound work:

```go
func workerPool(jobs <-chan Job, results chan<- Result, numWorkers int) {
    var wg sync.WaitGroup
    for i := 0; i < numWorkers; i++ {
        wg.Add(1)
        go func() {
            defer wg.Done()
            for job := range jobs {
                results <- process(job)
            }
        }()
    }
    wg.Wait()
    close(results)
}
```

## Fan-Out / Fan-In

Distribute work across multiple goroutines, then merge results:

```go
func fanOut(input <-chan int, numWorkers int) []<-chan int {
    channels := make([]<-chan int, numWorkers)
    for i := range channels {
        channels[i] = worker(input)
    }
    return channels
}

func fanIn(channels ...<-chan int) <-chan int {
    merged := make(chan int)
    var wg sync.WaitGroup
    for _, ch := range channels {
        wg.Add(1)
        go func(c <-chan int) {
            defer wg.Done()
            for v := range c { merged <- v }
        }(ch)
    }
    go func() { wg.Wait(); close(merged) }()
    return merged
}
```

## Context Cancellation

Always propagate context for graceful shutdown:

```go
func doWork(ctx context.Context) error {
    for {
        select {
        case <-ctx.Done():
            return ctx.Err()
        default:
            if err := processNext(ctx); err != nil {
                return err
            }
        }
    }
}
```

These three patterns cover 90% of concurrent Go code. Keep channels simple, propagate context everywhere, and use `sync.WaitGroup` to coordinate.
