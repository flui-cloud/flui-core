---
title: PostgreSQL dialect cheatsheet
---

Syntax that differs from other SQL dialects and that the query must get right.

- **Pagination:** `LIMIT n OFFSET m` (not `TOP`, not `FETCH FIRST` unless asked).
- **Case-insensitive match:** `ILIKE` (and `NOT ILIKE`); `~*` for case-insensitive regex,
  `~` for case-sensitive. `LIKE` is case-sensitive.
- **Casting:** `value::type` (e.g. `created_at::date`, `amount::numeric`) or
  `CAST(value AS type)`. Both are valid; `::` is idiomatic.
- **String concatenation:** `||` (e.g. `first_name || ' ' || last_name`). `+` does NOT
  concatenate strings.
- **Quoting:** single quotes `'...'` for string literals; double quotes `"..."` for
  identifiers. A camelCase or reserved column MUST be double-quoted: `"userId"`, `"order"`.
  Escape a single quote by doubling it: `'O''Brien'`.
- **Booleans:** real `boolean` type — `WHERE is_active` / `WHERE NOT is_active`,
  `= true` / `= false`. Avoid `= 1`.
- **NULL:** compare with `IS NULL` / `IS NOT NULL`, never `= NULL`. `COALESCE(a, b, …)`
  for fallbacks; `NULLIF(a, b)`.
- **`RETURNING`:** writes can return affected rows: `UPDATE … SET … WHERE … RETURNING id`.
- **`DISTINCT ON (cols)`:** Postgres-specific — keep the first row per group, paired with a
  matching `ORDER BY`.
- **`ON CONFLICT`:** upsert — `INSERT … ON CONFLICT (col) DO UPDATE SET …` /
  `DO NOTHING`. (Write — only when asked.)
- **Identifiers are lower-cased** unless double-quoted. `SELECT MyCol` reads `mycol`. If the
  schema shows `"MyCol"`, quote it.
- **Schema qualification:** when a table is not in `public`, qualify it
  (`analytics.events`). Use the schema shown in the provided schema tree.
- **`EXPLAIN` / `EXPLAIN ANALYZE`:** read-only; safe to suggest for performance questions
  (ANALYZE actually runs the query).
