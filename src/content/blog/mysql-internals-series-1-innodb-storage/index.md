---
title: "MySQL Internals Series, Part 1: Storage Engine & InnoDB Basics"
description: "How InnoDB stores data on disk — page structure, row format, clustered indexes, B-trees, and why the primary key matters."
pubDate: 2026-03-02
author: "ifkarsyah"
domain: "Backend"
stack: ["MySQL"]
image:
  src: ./mysql-series.png
  alt: "MySQL InnoDB Storage"
---

InnoDB is MySQL's default storage engine since version 5.5. It stores data in **pages** — fixed-size blocks (16 KB by default) organized in B-tree structures. Everything is a B-tree: tables, indexes, undo logs. Understanding page and row structure is the foundation for everything else.

This part is hands-on. We'll create a test table, inspect its internal structure, and learn why the primary key is so critical and how InnoDB differs from other storage engines.

## Page Structure in InnoDB

Every InnoDB page is 16,384 bytes (16 KB by default) and has this layout:

```
┌──────────────────────────────────────────┐
│ File Header (38 bytes)                    │ ← Page number, type, checksum
├──────────────────────────────────────────┤
│ Page Header (56 bytes)                    │ ← Record count, free space
├──────────────────────────────────────────┤
│ Infimum + Supremum Records (26 bytes)     │ ← Pseudo-records for B-tree
├──────────────────────────────────────────┤
│ User Records (variable)                   │ ← Actual table rows
├──────────────────────────────────────────┤
│ Free Space                                │
├──────────────────────────────────────────┤
│ Page Directory (variable)                 │ ← Slot offsets for search
├──────────────────────────────────────────┤
│ Trailer (8 bytes)                         │ ← Checksum, LSN
└──────────────────────────────────────────┘
```

**Key insight:** Unlike PostgreSQL's 8 KB pages, InnoDB pages are 16 KB. Records grow forward from the top, and the page directory at the bottom records slot positions for binary search within the page.

### File Header (38 bytes)

- **FIL_PAGE_OFFSET**: 4-byte page number within the tablespace
- **FIL_PAGE_TYPE**: 2-byte type (0=index, 3=undo log, etc.)
- **FIL_PAGE_PREV/NEXT**: 4-byte pointers to adjacent pages in doubly-linked list
- **FIL_PAGE_LSN**: 8-byte log sequence number (WAL position)
- **FIL_PAGE_SPACE_OR_CHKSUM**: 4-byte checksum or space ID

### Page Header (56 bytes)

- **PAGE_N_DIR_SLOTS**: Number of directory slots
- **PAGE_HEAP_TOP**: Offset to start of free space
- **PAGE_N_HEAP**: Total number of records (including delete-marked)
- **PAGE_FREE**: Offset to first free record
- **PAGE_GARBAGE**: Byte count of deleted records (compacted during reorganization)
- **PAGE_LAST_INSERT**: Offset to last inserted record
- **PAGE_DIRECTION**: Last insert direction (ascending/descending)
- **PAGE_N_RECS**: Number of user records (excluding infimum/supremum)

### Row Format

InnoDB supports multiple row formats. The most common are:

#### COMPACT Format (default until MySQL 5.0.3)

```
┌────────────────────────────────┐
│ Record Header (variable, 6-8   │
│   bytes: delete flag, type,    │
│   offset to next record)       │
├────────────────────────────────┤
│ Field Lengths (variable)       │ (1 or 2 bytes per variable-length field)
├────────────────────────────────┤
│ NULL Bitmap                    │ (1 bit per nullable field)
├────────────────────────────────┤
│ Column Values                  │ (fixed + variable-length data)
└────────────────────────────────┘
```

#### DYNAMIC Format (default since MySQL 5.7)

Similar to COMPACT, but with smarter overflow handling for large columns:

- **Small rows** (< 793 bytes) are stored entirely on the page
- **Large columns** (TEXT, BLOB, VARCHAR) may be **externally stored** — only the first 768 bytes are kept on the page, with a pointer to overflow pages

This reduces bloat when tables have mixed small and large columns.

#### COMPRESSED Format

Compresses entire pages using zlib. Useful for large tables, but adds CPU overhead.

### The Clustered Index

Here's the critical difference from PostgreSQL: **InnoDB tables ARE the primary key B-tree**. There is no separate heap. Every table *must* have a primary key — if you don't define one, InnoDB auto-generates a hidden 6-byte row ID.

**The clustered index stores:**
- Primary key columns
- All other user columns
- MVCC metadata (transaction IDs, roll pointers)

Secondary indexes store:
- Secondary key columns
- Clustered index key (the primary key)

This means a secondary index lookup requires two index searches: first find the primary key in the secondary index, then fetch the row from the clustered index. This is why **choosing a small primary key matters** — it's duplicated in every secondary index.

## Setting Up a Test Table

Let's create a table and inspect its structure:

```sql
CREATE TABLE users (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    email VARCHAR(255) NOT NULL UNIQUE,
    name VARCHAR(100),
    age INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_age (age)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC;

-- Insert some test data
INSERT INTO users (email, name, age) VALUES
    ('alice@example.com', 'Alice Smith', 30),
    ('bob@example.com', 'Bob Jones', 25),
    ('charlie@example.com', 'Charlie Brown', 35);
```

## Inspecting Internal Structure

Check the table's row format and space usage:

```sql
SELECT
    TABLE_SCHEMA,
    TABLE_NAME,
    ROW_FORMAT,
    TABLE_ROWS,
    AVG_ROW_LENGTH,
    DATA_LENGTH,
    INDEX_LENGTH,
    DATA_FREE
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_NAME = 'users' AND TABLE_SCHEMA = DATABASE();
```

This tells you:
- **ROW_FORMAT**: COMPACT, DYNAMIC, or COMPRESSED
- **TABLE_ROWS**: Estimated row count (may be approximate)
- **AVG_ROW_LENGTH**: Average bytes per row
- **DATA_LENGTH**: Total data storage in bytes
- **INDEX_LENGTH**: Total index storage
- **DATA_FREE**: Unused space (candidates for reclamation via `OPTIMIZE TABLE`)

Check index details:

```sql
SELECT
    TABLE_NAME,
    SEQ_IN_INDEX,
    COLUMN_NAME,
    INDEX_TYPE,
    SEQ_IN_INDEX AS KEY_NAME
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_NAME = 'users' AND TABLE_SCHEMA = DATABASE()
ORDER BY INDEX_NAME, SEQ_IN_INDEX;
```

This shows which columns are in which indexes and their order.

## Why the Primary Key Matters

Every row in InnoDB is stored in the clustered index (the primary key B-tree). If you don't define a primary key:

```sql
CREATE TABLE bad_table (
    col1 INT,
    col2 VARCHAR(100)
) ENGINE=InnoDB;
```

InnoDB auto-generates a hidden 6-byte **DB_ROW_ID** column. This wastes space:

1. The hidden column is not visible in queries, but it's stored in every row
2. It's included in every secondary index as the clustered key
3. Auto-increment on a hidden column can overflow (max ~281 trillion rows per table)

**Best practice:** Always define a PRIMARY KEY, and prefer:
- Single BIGINT for most tables
- Composite keys only when you have natural unique identifiers
- Keep the primary key small — it's duplicated in every secondary index

## Differences from PostgreSQL

| Aspect | PostgreSQL | MySQL/InnoDB |
|--------|-----------|-------------|
| **Storage** | Heap tables + B-tree indexes | B-tree tables + B-tree indexes |
| **Page Size** | 8 KB fixed | 16 KB default (configurable) |
| **Primary Key** | Optional, no special role | Required, stores all data |
| **Secondary Index** | Stores all columns (not just key) | Stores key + clustered key only |
| **Row Location** | By page number + slot (fixed) | By primary key (can move) |
| **Overflow Storage** | TOAST (transparent) | External pages (first 768 bytes inline) |

## Key Takeaways

1. **InnoDB tables ARE B-trees** — the clustered index is the table
2. **Primary keys matter** — they're duplicated in every secondary index, so keep them small
3. **Row format affects performance** — DYNAMIC is best for mixed workloads
4. **Pages are the unit of I/O** — a 16 KB page is read/written together
5. **Secondary indexes require two lookups** — first the index, then the clustered key

## Next Steps

In **Part 2**, we'll explore how transactions see multiple versions of rows simultaneously using MVCC, undo logs, and transaction IDs. You'll understand isolation levels and why they matter.

---

**Part 1 complete. Next: [MVCC & Transactions](/blog/mysql-internals-series-2-mvcc-transactions/)**
