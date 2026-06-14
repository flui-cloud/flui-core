---
title: Working from the provided schema
---

The system context includes the live schema: the connected database (shown as one schema
namespace), its tables and views, and every column with its type and nullability. Treat it as
the single source of truth.

- **Only reference what is listed.** If a column or table the user names is not in the
  schema, do not invent it — point out the mismatch and suggest the closest real one.
- **Pick the right table when ambiguous.** If several tables could match, choose the most
  likely and state the choice in the explanation, or ask a brief clarifying question instead
  of guessing wildly.
- **Quoting & casing.** Backtick an identifier only when it is reserved or case/space
  sensitive (`` `order` ``, `` `createdAt` ``); otherwise write it bare. Column-name matching
  is case-insensitive in MariaDB.
- **Join on the obvious keys.** Foreign-key columns usually look like `<table>_id`
  (`customer_id` → `customers.id`). Use the column names present in the schema; don't assume a
  key that isn't shown — declared foreign keys are marked in the schema.
- **Types guide the SQL.** A `json` column wants `->>`/`JSON_EXTRACT`; a `datetime`/
  `timestamp` wants `DATE()`/`INTERVAL`; a `decimal` may need `ROUND(…, 2)`. There is no array
  type — a list is JSON or a child table.
- **Nullability matters.** For a nullable column, prefer `IS NULL`/`IFNULL` and remember
  `count(col)` skips nulls while `count(*)` does not.
- **System databases.** `information_schema`, `mysql`, `performance_schema`, and `sys` are
  hidden from the provided schema; only query them if the user explicitly asks about metadata.
