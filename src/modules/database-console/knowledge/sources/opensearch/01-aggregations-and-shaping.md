---
title: Aggregations, sorting, paging and response shaping
---

## Aggregations (`aggs`)

When the user wants counts, groupings, stats or "top N by …", use `aggs` and set `size: 0`
(no hits needed). Aggregate on `keyword`/numeric/`date` fields, never on analyzed `text`.

- Group + count (terms bucket):
  ```json
  {
    "size": 0,
    "aggs": {
      "by_category": { "terms": { "field": "category.keyword", "size": 10 } }
    }
  }
  ```
- Time series (date histogram):
  ```json
  {
    "size": 0,
    "aggs": {
      "per_day": {
        "date_histogram": { "field": "created_at", "calendar_interval": "day" }
      }
    }
  }
  ```
- Metrics: `avg`, `sum`, `min`, `max`, `stats`, `cardinality` (distinct count), `percentiles`:
  ```json
  {
    "size": 0,
    "aggs": {
      "avg_price": { "avg": { "field": "price" } },
      "distinct_users": { "cardinality": { "field": "user_id.keyword" } }
    }
  }
  ```
- Nested: put sub-aggs under a bucket's `aggs` (e.g. `avg` price within each `terms` bucket).
- `top_hits` returns example documents per bucket.

Combine with a `query` to aggregate over a filtered subset (the query runs first).

## Sorting

`"sort": [ { "created_at": "desc" }, "_score" ]`. Sort on `keyword`/numeric/`date` only — a
`text` field needs its `.keyword` sub-field. `_score` is the default order for scored queries.

## Field selection & paging

- `"_source": ["title", "price"]` — return only these fields (or `false` for none).
- `"from": 0, "size": 20` — page window. Keep `size` modest; for deep paging the user should
  narrow the query instead.
- `"track_total_hits": true` — exact total when the count beyond 10k matters.

## Highlighting

`"highlight": { "fields": { "title": {} } }` — returns matched fragments per hit; use it when
the user wants to see _where_ the text matched.

## Count only

If the user just wants "how many", the console also has a count path — but from the assistant,
answer with `{ "size": 0, "query": … }` (hit count comes back in `hits.total`).
