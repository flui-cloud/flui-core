---
title: Common query patterns
---

Idiomatic shapes for the requests a copilot sees most.

**Filter + sort + page**

```sql
SELECT id, name, created_at
FROM customers
WHERE country = '<country>'
ORDER BY created_at DESC
LIMIT 100;
```

**Count / group counts**

```sql
SELECT status, count(*) AS n
FROM orders
GROUP BY status
ORDER BY n DESC;
```

**Join (always alias, qualify the join keys)**

```sql
SELECT o.id, o.total, c.email
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.created_at >= now() - interval '30 days';
```

**Top-N per group** — prefer `DISTINCT ON` for "the latest/first per X":

```sql
SELECT DISTINCT ON (customer_id) customer_id, id, created_at
FROM orders
ORDER BY customer_id, created_at DESC;
```

Or a window function when you need a rank/several per group:

```sql
SELECT *
FROM (
  SELECT o.*, row_number() OVER (PARTITION BY customer_id ORDER BY created_at DESC) AS rn
  FROM orders o
) t
WHERE rn <= 3;
```

**CTE for readability** (a `WITH` chain, not for performance):

```sql
WITH recent AS (
  SELECT * FROM orders WHERE created_at >= now() - interval '7 days'
)
SELECT customer_id, count(*) FROM recent GROUP BY customer_id;
```

**Existence / anti-join**

```sql
SELECT c.id, c.email
FROM customers c
WHERE NOT EXISTS (SELECT 1 FROM orders o WHERE o.customer_id = c.id);
```

**Preview before a write** — when the user asks to delete/update, first offer the matching
`SELECT` so they can confirm scope:

```sql
SELECT id FROM sessions WHERE expires_at < now();  -- rows a DELETE … WHERE expires_at < now() would touch
```
