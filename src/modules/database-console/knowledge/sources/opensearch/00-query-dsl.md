---
title: Query DSL — leaf and compound queries
---

The request `body` always has a `query` (unless `size: 0` with only `aggs`). Pick the leaf
query from the field's type, and combine with `bool` when there is more than one condition.

## Full-text (analyzed `text` fields)

- `{ "match": { "title": "wireless mouse" } }` — analyzed match; any term, OR by default.
- `{ "match": { "title": { "query": "wireless mouse", "operator": "and" } } }` — all terms.
- `{ "match_phrase": { "title": "wireless mouse" } }` — terms in order, adjacent.
- `{ "multi_match": { "query": "wireless", "fields": ["title", "description"] } }` — many fields.
- `{ "query_string": { "query": "wireless AND (mouse OR keyboard)" } }` — Lucene mini-language.

## Exact / structured (`keyword`, numeric, `boolean`, `date`)

- `{ "term": { "status.keyword": "active" } }` — exact single value (no analysis).
- `{ "terms": { "category.keyword": ["a", "b"] } }` — value in a set.
- `{ "range": { "price": { "gte": 10, "lt": 100 } } }` — numeric/date range. Date math:
  `{ "range": { "created_at": { "gte": "now-7d/d", "lte": "now" } } }`.
- `{ "exists": { "field": "deleted_at" } }` — field is present (non-null).
- `{ "prefix": { "sku.keyword": "AB-" } }`, `{ "wildcard": { "sku.keyword": "AB-*23" } }`.
- `{ "ids": { "values": ["1", "2"] } }` — by document `_id`.
- `{ "match_all": {} }` — everything (default when the user asks "show all").

## Compound — `bool`

Combine clauses; `filter` and `must_not` run in non-scoring (cacheable) context, `must`/`should`
contribute to score:

```json
{
  "bool": {
    "must": [{ "match": { "title": "laptop" } }],
    "filter": [
      { "range": { "price": { "lte": 1500 } } },
      { "term": { "in_stock": true } }
    ],
    "must_not": [{ "term": { "discontinued": true } }],
    "should": [{ "match": { "brand": "acme" } }],
    "minimum_should_match": 1
  }
}
```

Prefer `filter` over `must` for yes/no conditions (ranges, terms, booleans) — same result,
faster, no scoring noise. Use `must`/`should` only when relevance ranking matters.
