---
title: Dates, times, and intervals
---

- **Now:** `NOW()` / `CURRENT_TIMESTAMP` (datetime), `CURDATE()` / `CURRENT_DATE`,
  `CURTIME()`.
- **Relative ranges:** `created_at >= NOW() - INTERVAL 30 DAY`, `INTERVAL 1 HOUR`,
  `INTERVAL 2 WEEK`, `INTERVAL 6 MONTH`. The keyword is `INTERVAL <n> <UNIT>` (unit unquoted,
  singular: `DAY`, `HOUR`, `MONTH`, …) — NOT a quoted string like `'30 days'`.
- **Truncate to a bucket:** there is no `date_trunc`. Use:
  - day → `DATE(created_at)`
  - month → `DATE_FORMAT(created_at, '%Y-%m-01')` (or `LAST_DAY` for month boundaries)
  - hour → `DATE_FORMAT(created_at, '%Y-%m-%d %H:00:00')`
  - week → `YEARWEEK(created_at, 1)` (mode 1 = ISO, Monday-start).
- **Extract a field:** `YEAR(x)`, `MONTH(x)`, `DAY(x)`, `HOUR(x)`, `DAYOFWEEK(x)`
  (1=Sunday), `WEEKDAY(x)` (0=Monday). Seconds between two times:
  `TIMESTAMPDIFF(SECOND, a, b)`.
- **Format:** `DATE_FORMAT(created_at, '%Y-%m-%d %H:%i')`.
- **Parse:** `STR_TO_DATE('2024-01-31', '%Y-%m-%d')`.

**Daily counts (time series)**

```sql
SELECT DATE(created_at) AS day, count(*) AS n
FROM events
WHERE created_at >= NOW() - INTERVAL 30 DAY
GROUP BY day
ORDER BY day;
```

**This month**

```sql
SELECT * FROM invoices
WHERE created_at >= DATE_FORMAT(CURDATE(), '%Y-%m-01')
LIMIT 100;
```
