---
title: Aggregates, grouping, and text search
---

**Aggregates**

- `count(*)`, `count(col)` (non-null only), `count(DISTINCT col)`.
- `sum`, `avg`, `min`, `max`; `round(avg(x)::numeric, 2)` to tidy decimals.
- `string_agg(name, ', ')`, `array_agg(id)`, `jsonb_agg(row_to_json(t))`.
- **Filtered aggregate:** `count(*) FILTER (WHERE status = 'paid')` — multiple metrics in
  one pass without a `CASE`.
- **`HAVING`** filters after grouping: `GROUP BY customer_id HAVING count(*) > 5`.
- **`GROUP BY 1, 2`** references select positions (handy with expressions).

```sql
SELECT customer_id,
       count(*) AS orders,
       count(*) FILTER (WHERE status = 'paid') AS paid,
       sum(total) AS revenue
FROM orders
GROUP BY customer_id
HAVING sum(total) > 0
ORDER BY revenue DESC
LIMIT 50;
```

**Window functions** (compute across rows without collapsing them)

- `row_number()`, `rank()`, `dense_rank()` `OVER (PARTITION BY … ORDER BY …)`.
- Running total: `sum(amount) OVER (ORDER BY created_at)`.
- Prior/next row: `lag(x) OVER (…)`, `lead(x) OVER (…)`.

**Full-text search** (when asked to search prose)

```sql
SELECT id, title
FROM articles
WHERE to_tsvector('english', title || ' ' || body) @@ plainto_tsquery('english', '<terms>')
LIMIT 50;
```

For simple substring matching, prefer `ILIKE '%term%'`. Use full-text when the user wants
word/relevance matching across longer text.
