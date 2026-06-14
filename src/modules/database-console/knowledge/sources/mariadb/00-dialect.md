---
title: MariaDB dialect cheatsheet
---

Syntax that differs from other SQL dialects (notably PostgreSQL) and that the query must get
right. This targets MariaDB (MySQL-compatible).

- **Pagination:** `LIMIT n OFFSET m` or the shorthand `LIMIT m, n`. No `TOP`.
- **Quoting:** **backticks** for identifiers — `` `userId` ``, `` `order` `` (a reserved or
  camelCase name MUST be backtick-quoted). Single quotes `'...'` for string literals. Escape a
  single quote by doubling it (`'O''Brien'`) or with a backslash (`'O\'Brien'`). Do not use
  double quotes for identifiers (they read as strings unless `ANSI_QUOTES` is set).
- **Case-insensitive match:** the default `*_ci` collation makes `=` and `LIKE` already
  case-insensitive for text. For case-sensitive matching use `LIKE BINARY` or
  `... COLLATE utf8mb4_bin`. Regex: `col REGEXP 'pattern'` (alias `RLIKE`); regex is
  case-insensitive under a `_ci` collation.
- **Casting:** `CAST(x AS type)` / `CONVERT(x, type)` with MySQL cast targets:
  `SIGNED`, `UNSIGNED`, `DECIMAL(10,2)`, `CHAR`, `DATE`, `DATETIME`, `JSON`. There is **no**
  `::` cast and no `text`/`int4` type names.
- **String concatenation:** `CONCAT(a, b, …)` or `CONCAT_WS(sep, …)`. `||` means logical OR
  by default (NOT concatenation); `+` is numeric addition, not concatenation.
- **Booleans:** `BOOLEAN`/`BOOL` is an alias for `TINYINT(1)`; `TRUE`/`FALSE` are `1`/`0`.
  `WHERE is_active` and `WHERE NOT is_active` work; `= 1` / `= 0` also work.
- **NULL:** compare with `IS NULL` / `IS NOT NULL`, never `= NULL`. Null-safe equality is
  `<=>`. Fallbacks: `IFNULL(a, b)` (two args) or `COALESCE(a, b, …)`; `NULLIF(a, b)`.
- **`RETURNING`:** MariaDB 10.5+ supports `INSERT … RETURNING …` and `DELETE … RETURNING …`
  (NOT `UPDATE`). Only use it when the target version is ≥ 10.5.
- **Upsert:** `INSERT … ON DUPLICATE KEY UPDATE …`, `INSERT IGNORE …`, or `REPLACE INTO …`
  (note: `REPLACE` deletes + reinserts). (Writes — only when asked.)
- **Auto-increment / keys:** integer PKs use `AUTO_INCREMENT` (not `SERIAL`/`IDENTITY`).
- **Schema = database.** A "schema" IS a database here; qualify cross-database as
  `dbname.table`. The console connects to one database; use the tables shown in the schema.
- **`EXPLAIN` / `ANALYZE`:** `EXPLAIN <query>` (read-only plan); `ANALYZE <query>` actually
  runs the query and reports real timings.
