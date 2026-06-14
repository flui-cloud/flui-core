---
title: Aggregates, grouping, and text search
---

**Aggregates**

- `count(*)`, `count(col)` (non-null only), `count(DISTINCT col)`.
- `sum`, `avg`, `min`, `max`; `ROUND(avg(x), 2)` to tidy decimals.
- `GROUP_CONCAT(name SEPARATOR ', ')` to collapse a group into a string
  (cap with `GROUP_CONCAT(... ORDER BY ...)`; watch `group_concat_max_len`).
- **No `FILTER (WHERE …)` clause.** Use a conditional sum instead:
  `SUM(status = 'paid')` (booleans are 1/0) or `COUNT(CASE WHEN status = 'paid' THEN 1 END)`.
- **`HAVING`** filters after grouping: `GROUP BY customer_id HAVING count(*) > 5`.
- **`GROUP BY 1, 2`** references select positions.

```sql
SELECT customer_id,
       count(*) AS orders,
       SUM(status = 'paid') AS paid,
       sum(total) AS revenue
FROM orders
GROUP BY customer_id
HAVING sum(total) > 0
ORDER BY revenue DESC
LIMIT 50;
```

**Window functions** (MariaDB 10.2+; compute across rows without collapsing them)

- `row_number()`, `rank()`, `dense_rank()` `OVER (PARTITION BY … ORDER BY …)`.
- Running total: `sum(amount) OVER (ORDER BY created_at)`.
- Prior/next row: `lag(x) OVER (…)`, `lead(x) OVER (…)`.

**Full-text search** (requires a `FULLTEXT` index on the column(s))

```sql
SELECT id, title
FROM articles
WHERE MATCH(title, body) AGAINST('<terms>' IN NATURAL LANGUAGE MODE)
LIMIT 50;
```

If there is no FULLTEXT index (none shown in the schema), fall back to `LIKE '%term%'` for
substring matching.
