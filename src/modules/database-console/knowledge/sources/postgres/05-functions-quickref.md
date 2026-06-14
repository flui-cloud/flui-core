---
title: Function quick reference
---

Common built-ins, grouped. Reach for these before inventing one.

**String**
`lower`, `upper`, `initcap`, `length`, `trim`, `btrim`, `ltrim`, `rtrim`,
`substr(s, from, len)`, `left(s, n)`, `right(s, n)`, `replace(s, from, to)`,
`split_part(s, delim, n)`, `concat_ws(sep, …)`, `position(sub in s)`,
`regexp_replace(s, pattern, repl, 'g')`, `regexp_matches(s, pattern)`,
`s ~ 'pattern'` (regex match), `format('%s-%s', a, b)`.

**Numeric**
`round(x, d)`, `ceil`, `floor`, `trunc(x, d)`, `abs`, `mod(a, b)`, `power(a, b)`,
`greatest(…)`, `least(…)`, `width_bucket(x, lo, hi, n)`.

**Conditional**
`coalesce(a, b, …)`, `nullif(a, b)`,
`CASE WHEN cond THEN x WHEN cond2 THEN y ELSE z END`.

**Type / cast**
`x::int`, `x::numeric`, `x::text`, `x::date`, `x::boolean`, `x::uuid`,
`to_char`, `to_number`, `to_timestamp`, `to_date`.

**Set-returning (use in FROM or SELECT)**
`generate_series(1, 10)`, `generate_series(d1, d2, interval '1 day')`,
`unnest(array)`, `jsonb_array_elements(j)`.

**Misc**
`gen_random_uuid()` (needs pgcrypto), `md5(s)`, `random()`,
`row_to_json(t)`, `to_jsonb(x)`.
