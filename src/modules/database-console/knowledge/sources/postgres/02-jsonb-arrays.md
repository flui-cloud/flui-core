---
title: JSONB and arrays
---

**JSON / JSONB access**

- `->` returns JSON, `->>` returns text: `data -> 'address' ->> 'city'`.
- Path: `data #> '{address,city}'` (JSON), `data #>> '{address,city}'` (text).
- Containment: `data @> '{"active": true}'` (does data contain this?).
- Key existence: `data ? 'email'`; any of `data ?| array['a','b']`; all `data ?& array['a','b']`.
- Cast extracted text before comparing numerically: `(data ->> 'age')::int > 18`.
- Expand an array of objects to rows: `jsonb_array_elements(data -> 'items')`.
- Keys of an object as rows: `jsonb_object_keys(data)`.

```sql
SELECT id, data ->> 'email' AS email
FROM events
WHERE data @> '{"type": "signup"}'
LIMIT 100;
```

**Arrays** (native `type[]` columns)

- Membership: `'admin' = ANY(roles)`; overlap: `roles && array['admin','owner']`.
- Length: `cardinality(roles)` or `array_length(roles, 1)`.
- Expand to rows: `unnest(roles)`; with index: `unnest(roles) WITH ORDINALITY`.
- Build: `array_agg(x)`; aggregate distinct: `array_agg(DISTINCT x)`.

```sql
SELECT id, name FROM users WHERE 'admin' = ANY(roles);
```
