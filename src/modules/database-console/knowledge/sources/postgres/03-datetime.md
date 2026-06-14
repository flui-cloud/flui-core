---
title: Dates, times, and intervals
---

- **Now:** `now()` / `current_timestamp` (timestamptz), `current_date`, `current_time`.
- **Relative ranges:** `created_at >= now() - interval '30 days'`,
  `interval '1 hour'`, `'2 weeks'`, `'6 months'`. Add/subtract intervals directly.
- **Truncate to a bucket:** `date_trunc('day', created_at)` — also `'hour'`, `'week'`,
  `'month'`, `'year'`. Ideal for time-series grouping.
- **Extract a field:** `extract(year from created_at)`, `extract(dow from created_at)`
  (0=Sunday), `extract(epoch from (a - b))` for seconds between two timestamps.
- **Cast to date** to group/compare by calendar day: `created_at::date = current_date`.
- **Format:** `to_char(created_at, 'YYYY-MM-DD HH24:MI')`.
- **Parse:** `to_timestamp('2024-01-31', 'YYYY-MM-DD')`, `'2024-01-31'::date`.
- **Time zones:** `created_at AT TIME ZONE 'UTC'`; a `timestamptz` is stored in UTC and
  rendered in the session zone.

**Daily counts (time series)**

```sql
SELECT date_trunc('day', created_at) AS day, count(*) AS n
FROM events
WHERE created_at >= now() - interval '30 days'
GROUP BY 1
ORDER BY 1;
```

**This month**

```sql
SELECT * FROM invoices
WHERE created_at >= date_trunc('month', current_date)
LIMIT 100;
```
