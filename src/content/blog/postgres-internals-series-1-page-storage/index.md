---
title: "PostgreSQL Internals Series, Part 1: Page Layout & Storage"
description: "How PostgreSQL stores data on disk — page structure, tuple anatomy, alignment, TOAST, and practical inspection with pageinspect."
pubDate: 2026-03-02
author: "ifkarsyah"
domain: "Backend"
stack: ["PostgreSQL"]
image:
  src: ./postgres-series.png
  alt: "PostgreSQL Page Layout"
---

PostgreSQL stores data in **pages** — fixed 8KB blocks on disk (by default). Everything lives in pages: table data (heap), index entries, even free space tracking. Understanding page structure is the foundation for understanding everything else.

This part is hands-on. We'll build a test table, inspect its pages byte-by-byte, and learn why tuple alignment and TOAST matter for performance.

## Page Structure

Every page is 8192 bytes and has this layout:

```
┌─────────────────────────────────────────┐
│ PageHeaderData (24 bytes)                │ ← LSN, flags, free space
├─────────────────────────────────────────┤
│ ItemIdData[] (4 bytes per tuple)         │ ← Pointers to tuples
├─────────────────────────────────────────┤
│ ...free space...                         │
├─────────────────────────────────────────┤
│ ...tuple data...                         │ (stored from end backwards)
└─────────────────────────────────────────┘
```

**Key insight:** Tuple data grows backwards from the end of the page. This leaves free space in the middle for new tuples or index entries.

### Header (24 bytes)

The `PageHeaderData` struct contains:

- **pd_lsn** (8 bytes): Log sequence number (WAL position) when page was last modified
- **pd_checksum** (2 bytes): Optional page checksum for corruption detection
- **pd_flags** (2 bytes): Bit flags (reserved, all visible, etc.)
- **pd_lower** (2 bytes): Offset to first free space after the last line pointer
- **pd_upper** (2 bytes): Offset to start of tuples
- **pd_special** (2 bytes): Offset to page-specific data (used by indexes, not heap)
- **pd_pagesize_version** (2 bytes): Page size and PostgreSQL version
- **pd_linp** (variable): Array of line pointers (4 bytes each)

## Line Pointers

After the header comes an array of **line pointers** (4 bytes each), one per tuple on the page.

```c
typedef struct ItemPointerData {
    BlockIdData ip_blkid;    // 4 bytes: block number within relation
    OffsetNumber ip_posid;   // 2 bytes: offset within page
} ItemPointerData;
```

The line pointer is the tuple's address: `(block, offset)`. This is how PostgreSQL references tuples — not by byte position, but by their block and slot number. This allows tuples to be moved within a page (during VACUUM) without breaking references to them.

## Tuple Structure

Each tuple starts with a **HeapTupleHeaderData** (23 bytes minimum) followed by user data:

```c
typedef struct HeapTupleHeaderData {
    union {
        HeapTupleFields t_heap;
        DatumTupleFields t_datum;
    } t_choice;
    ItemPointerData t_ctid;      // 6 bytes: current item pointer (for MVCC)
    uint16 t_infomask;           // 2 bytes: visibility flags
    uint16 t_infomask2;          // 2 bytes: more flags
    uint8 t_hoff;                // 1 byte: offset to user data
    uint8 t_bits[1];             // Variable: NULL bitmap
} HeapTupleHeaderData;
```

### Tuple Header Fields (MVCC metadata)

- **xmin** (4 bytes): ID of transaction that inserted this tuple
- **xmax** (4 bytes): ID of transaction that deleted this tuple (0 if active)
- **xvac** (4 bytes): Transaction ID of VACUUM that moved this tuple
- **t_ctid**: Current item pointer (points to self or the newer version)
- **t_infomask**: Flags (HEAP_XMIN_COMMITTED, HEAP_XMIN_INVALID, HEAP_XMAX_COMMITTED, etc.)
- **t_hoff**: Byte offset from tuple start to user data (after NULL bitmap)

These fields enable **MVCC** — different transactions see different versions of the same tuple based on visibility rules (Part 2).

### NULL Bitmap

If the table has NULLable columns, a **NULL bitmap** follows the header. It's a bit array where bit N indicates if column N is NULL. For tables with no nullable columns, this is omitted entirely.

**Formula for NULL bitmap size:** `BITMAPLEN(natts) = ((natts) + 7) / 8` bytes

### User Data

After the header and NULL bitmap comes the actual column values, stored in attribute order.

**Alignment rule:** Most data types require alignment. For example:
- `int4` (4 bytes) must start at a 4-byte boundary
- `int8` (8 bytes) must start at an 8-byte boundary

PostgreSQL pads data to ensure alignment. This is why a table with `(int1, int8)` wastes 7 bytes of padding — the int8 needs to start at an 8-byte boundary.

## Example: Inspecting a Page

Let's create a test table and look at its storage:

```sql
-- Create test table
CREATE TABLE users (
    id BIGINT,
    name TEXT,
    age INT,
    email TEXT
);

-- Insert a few rows
INSERT INTO users VALUES
    (1, 'Alice', 30, 'alice@example.com'),
    (2, 'Bob', 25, 'bob@example.com'),
    (3, 'Charlie', 35, 'charlie@example.com');

-- Enable pageinspect extension
CREATE EXTENSION IF NOT EXISTS pageinspect;
```

Now inspect the page header:

```sql
SELECT * FROM page_header(get_raw_page('users', 0));
```

Output:
```
 lsn | checksum | flags | lower | upper | special | pagesize | version | prune_xid
-----+----------+-------+-------+-------+---------+----------+---------+-----------
 0/0 |        0 |     0 |    44 |  8128 |    8192 |     8192 |      18 |         0
```

This tells us:
- **lower** = 44: The line pointer array ends at byte 44 (header is 24 bytes + 4 line pointers = 44)
- **upper** = 8128: Tuple data starts at byte 8128
- **Free space**: 8128 - 44 = 8084 bytes available for new tuples

Now inspect individual tuples:

```sql
SELECT * FROM heap_page_items(get_raw_page('users', 0));
```

Output:
```
 lp | lp_off | lp_flags | lp_len | t_xmin | t_xmax | t_field3 | t_ctid | t_infomask | t_infomask2 | t_hoff | t_bits | t_oid
----+--------+----------+--------+--------+--------+----------+--------+------------+-------------+--------+--------+-------
  1 |   8128 |        1 |     48 |    742 |      0 | 0        | (0,1)  |       2050 |           2 |     24 |        |
  2 |   8080 |        1 |     48 |    743 |      0 | 0        | (0,2)  |       2050 |           2 |     24 |        |
  3 |   8032 |        1 |     48 |    744 |      0 | 0        | (0,3)  |       2050 |           2 |     24 |        |
```

Key observations:
- **lp** (line pointer 1, 2, 3): Each tuple has a pointer
- **t_xmin** (742, 743, 744): Different transaction IDs created each tuple
- **t_xmax** (0): All tuples are active (not deleted)
- **t_ctid** ((0,1), (0,2), (0,3)): Each tuple points to itself (or would point to a newer version if updated)
- **t_hoff** (24): User data starts at byte 24 (no NULL bitmap, all columns are NOT NULL)

Decode the actual tuple data:

```sql
SELECT t_ctid, encode(t_data, 'hex') as hex_data
FROM heap_page_items(get_raw_page('users', 0));
```

The hex output shows raw bytes. The `id` (int8) comes first, then `name` (variable length text), then `age` (int4), then `email` (variable length text).

## TOAST — Out-of-Line Storage

PostgreSQL has a **4KB limit per tuple** (after TOAST compression). Large values (text, bytea, arrays) are stored separately in a **TOAST table** (Tuple Attribute Storage).

When a column value is too large:

1. PostgreSQL compresses it (if compression works)
2. If still too large, stores it in the TOAST table
3. The original tuple holds a **TOAST pointer** (18 bytes) instead of the data

**Example:**

```sql
CREATE TABLE documents (
    id BIGINT,
    content TEXT
);

INSERT INTO documents VALUES (1, repeat('x', 100000));

-- Check page size
SELECT * FROM page_header(get_raw_page('documents', 0));
```

The tuple on the heap page is now ~18 bytes (just the TOAST pointer), and the actual content lives in a separate TOAST table.

**When TOAST activates:**
- `storage_type` parameter per column controls this
- Default behavior: compress, then TOAST if still > 2KB
- Can force `EXTERNAL` (never compress, TOAST immediately) or `PLAIN` (never TOAST)

```sql
CREATE TABLE big_data (
    id BIGINT,
    data BYTEA STORAGE EXTERNAL
);
```

## Practical Impact: Page Density & Performance

The tuple overhead is **24 bytes** (header) + NULL bitmap (if needed) + padding for alignment.

For a table with small rows (e.g., `(int4, int4, int4)` = 12 bytes data + 24 byte header = 36 bytes):
- Tuples per page: ~8192 / 36 ≈ 227 tuples
- With 100M rows, you need ~440,000 pages = ~3.4 GB

For a table with large rows (e.g., `(text, text, text)` with 1KB each):
- Tuples per page: ~8192 / 3KB ≈ 2–3 tuples
- With 100M rows, you need ~50M pages = ~390 GB

**Implications:**
- Wider tables = slower scans (fewer tuples per page, more I/O)
- Unnecessary columns bloat the table size
- Column order matters for padding efficiency
- TOAST effectively "unbundles" large values from the main table

## Checking Table Size

```sql
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename)) AS total_size,
    pg_size_pretty(pg_relation_size(schemaname || '.' || tablename)) AS table_size,
    pg_size_pretty(pg_total_relation_size(schemaname || '.' || tablename) - pg_relation_size(schemaname || '.' || tablename)) AS indexes_and_toast
FROM pg_tables t
WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
ORDER BY pg_total_relation_size(schemaname || '.' || tablename) DESC;
```

## Key Takeaways

- **Pages are 8KB fixed blocks.** Tuple data grows backwards from the end, leaving free space for growth.
- **Line pointers enable indirection.** Tuples can be moved within a page without breaking references.
- **Tuple headers carry MVCC metadata** (xmin, xmax, t_ctid). This overhead is unavoidable — roughly 24 bytes per tuple.
- **Alignment and padding waste space.** Column order impacts layout efficiency.
- **TOAST unbundles large values** to the TOAST table, keeping the main tuple small.
- **Pageinspect extension** lets you inspect pages directly — invaluable for debugging storage issues.

## Monitoring Page Health

Check table bloat and page efficiency:

```sql
SELECT
    schemaname,
    tablename,
    pg_size_pretty(pg_relation_size(schemaname || '.' || tablename)) AS size,
    (SELECT count(*) FROM pg_class WHERE relname = tablename) AS row_count
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY pg_relation_size(schemaname || '.' || tablename) DESC;
```

## Next Steps

Now that you understand how PostgreSQL stores individual tuples, the question becomes: **how does it handle concurrent modifications to those tuples?** When one transaction deletes a row and another transaction reads it simultaneously, who sees what?

This is **MVCC** — multi-version concurrency control. Every tuple carries visibility metadata, and every transaction sees a snapshot of the database at a specific point in time.

---

**Part 1 complete. Next: [Transaction Isolation & MVCC](/blog/postgres-internals-series-2-mvcc-transactions/)**
