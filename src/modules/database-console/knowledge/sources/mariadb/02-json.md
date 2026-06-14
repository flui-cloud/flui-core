---
title: JSON (and the absence of arrays)
---

MariaDB stores JSON as `LONGTEXT` with JSON functions on top. There is **no native array
type** (unlike Postgres `type[]`): model lists as JSON arrays or, better, as a related table.

**JSON access**

- Extract: `JSON_EXTRACT(data, '$.address.city')`, or the shorthand `data->'$.address.city'`
  (returns JSON, quoted) and `data->>'$.address.city'` (returns unquoted text).
- Value with type hint: `JSON_VALUE(data, '$.age' RETURNING INT)` (MariaDB 10.9+).
- Containment / membership: `JSON_CONTAINS(data, '"signup"', '$.type')`.
- Key existence: `JSON_CONTAINS_PATH(data, 'one', '$.email')`.
- Object keys as a JSON array: `JSON_KEYS(data)`.
- Cast extracted text before comparing numerically: `CAST(data->>'$.age' AS UNSIGNED) > 18`.

```sql
SELECT id, data->>'$.email' AS email
FROM events
WHERE data->>'$.type' = 'signup'
LIMIT 100;
```

**Expanding a JSON array to rows** — use `JSON_TABLE` (MariaDB 10.6+):

```sql
SELECT e.id, j.item
FROM events e,
     JSON_TABLE(e.data, '$.items[*]' COLUMNS (item VARCHAR(255) PATH '$')) AS j
LIMIT 100;
```

If the user has a list stored in a separate table (the normalized design), prefer a plain
`JOIN` over JSON expansion.
