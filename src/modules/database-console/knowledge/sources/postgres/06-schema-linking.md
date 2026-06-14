---
title: Working from the provided schema
---

The system context includes the live schema: each schema namespace, its tables and views,
and every column with its type and nullability. Treat it as the single source of truth.

- **Only reference what is listed.** If a column or table the user names is not in the
  schema, do not invent it — point out the mismatch and suggest the closest real one.
- **Pick the right table when ambiguous.** If several tables could match the request,
  choose the most likely and state the choice in the explanation, or ask a brief
  clarifying question instead of guessing wildly.
- **Respect casing.** If the schema shows `"createdAt"` (mixed case), you must double-quote
  it; if it shows `created_at`, write it bare.
- **Join on the obvious keys.** Foreign-key columns usually look like `<table>_id`
  (`customer_id` → `customers.id`). Use the column names present in the schema; don't assume
  a key that isn't shown.
- **Types guide the SQL.** A `jsonb` column wants `->>`/`@>`; a `text[]` wants
  `ANY`/`unnest`; a `timestamptz` wants `date_trunc`/`interval`; a `numeric` may need
  `round(…, 2)`.
- **Nullability matters.** For a nullable column, prefer `IS NULL`/`coalesce` and remember
  `count(col)` skips nulls while `count(*)` does not.
- **System tables.** `pg_catalog` and `information_schema` are hidden from the provided
  schema; only query them if the user explicitly asks about database metadata.
