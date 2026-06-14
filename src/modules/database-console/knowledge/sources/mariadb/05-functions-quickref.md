---
title: Function quick reference
---

Common built-ins, grouped. Reach for these before inventing one.

**String**
`LOWER`, `UPPER`, `CHAR_LENGTH` (chars) / `LENGTH` (bytes), `TRIM`, `LTRIM`, `RTRIM`,
`SUBSTRING(s, pos, len)`, `LEFT(s, n)`, `RIGHT(s, n)`, `REPLACE(s, from, to)`,
`SUBSTRING_INDEX(s, delim, n)`, `CONCAT_WS(sep, …)`, `LOCATE(sub, s)`,
`REGEXP_REPLACE(s, pattern, repl)` (MariaDB 10.0.5+), `s REGEXP 'pattern'`.

**Numeric**
`ROUND(x, d)`, `CEIL`/`CEILING`, `FLOOR`, `TRUNCATE(x, d)`, `ABS`, `MOD(a, b)`,
`POWER(a, b)`, `GREATEST(…)`, `LEAST(…)`.

**Conditional**
`COALESCE(a, b, …)`, `IFNULL(a, b)`, `NULLIF(a, b)`, `IF(cond, a, b)`,
`CASE WHEN cond THEN x WHEN cond2 THEN y ELSE z END`.

**Type / cast**
`CAST(x AS SIGNED)`, `CAST(x AS DECIMAL(10,2))`, `CAST(x AS CHAR)`, `CAST(x AS DATE)`,
`CAST(x AS DATETIME)`, `CONVERT(x, type)`. (No `::` operator.)

**Date** — see the dates section: `NOW`, `CURDATE`, `DATE`, `DATE_FORMAT`, `STR_TO_DATE`,
`TIMESTAMPDIFF`, `INTERVAL <n> <UNIT>`.

**JSON**
`JSON_EXTRACT`, `data->'$.x'`, `data->>'$.x'`, `JSON_CONTAINS`, `JSON_KEYS`,
`JSON_OBJECT(...)`, `JSON_ARRAYAGG(x)`, `JSON_TABLE(...)`.

**Misc**
`UUID()`, `MD5(s)`, `RAND()`, `ROW_NUMBER()`/window functions, `LAST_INSERT_ID()`.

There is **no** `generate_series`; for a numbers/dates sequence use the MariaDB Sequence
engine virtual tables (e.g. `seq_1_to_100`) or `JSON_TABLE`.
