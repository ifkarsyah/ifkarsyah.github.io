---
title: 4. PostgreSQL Internal
summary: PostgreSQL Internal
type: docs

sections:
  - block: collection
    id: postgresql-internal
    content:
      title: PostgreSQL Internal
      filters:
        folders:
          - tutorial-postgres 
    design:
      view: article-grid
---


- How PostgreSQL Works: Architecture overview – processes, memory, storage, and caching.
- Transaction and Concurrency Control: Deep dive into MVCC (Multiversion Concurrency Control).
- Query Planning and Execution: Explain how the query planner and optimizer work and ways to understand execution plans.
- Storage Mechanisms: Explanation of tables, indexes, and data storage structures (e.g., heap, B-trees).
- Logging and WAL (Write-Ahead Logging): Insight into how WAL works and its role in data durabity and crash recovery.
- PostgreSQL Configuration Tuning: How to tune key parameters (e.g., work_mem, shared_buffers, etc.) for optimal performance.
- Background Processes and Autovacuum: Overview of background processes and the role of autovacuum.
- Extending PostgreSQL: Writing custom extensions, PL/pgSQL, and foreign data wrappers (FDWs) for advanced customization.
