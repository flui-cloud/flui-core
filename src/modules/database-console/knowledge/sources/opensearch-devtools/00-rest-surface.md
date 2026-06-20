---
title: REST surface — the calls you can produce
---

## Read / inspect (safe under read-only)

- `GET /_cat/indices?v` — list indices (add `&h=index,health,docs.count` to pick columns).
- `GET /_cat/health?v` or `GET /_cluster/health` — cluster status.
- `GET /<index>/_mapping` — field types of an index. `GET /<index>/_settings` — settings.
- `POST /<index>/_search` with a query-DSL body — run a search.
- `POST /<index>/_count` with `{ "query": … }` — count matches.
- `GET /<index>/_doc/<id>` — fetch one document by id.

## Create / change indices (write)

- Create an index with a mapping:
  ```
  PUT /<index>
  { "settings": { "number_of_shards": 1 },
    "mappings": { "properties": {
      "title": { "type": "text" }, "status": { "type": "keyword" },
      "price": { "type": "float" }, "created_at": { "type": "date" } } } }
  ```
- Add fields to an existing mapping (you can only add, not change a field's type):
  ```
  PUT /<index>/_mapping
  { "properties": { "tags": { "type": "keyword" } } }
  ```
- Update index settings: `PUT /<index>/_settings` with `{ "index": { … } }`.
- Delete an index: `DELETE /<index>` — destructive.

## Documents (write)

- Index with an auto id: `POST /<index>/_doc` + the document body.
- Index/replace at a known id: `PUT /<index>/_doc/<id>` + the document body.
- Partial update: `POST /<index>/_update/<id>` with `{ "doc": { … } }`.
- Delete one: `DELETE /<index>/_doc/<id>`.
- Update/delete by query: `POST /<index>/_update_by_query` / `POST /<index>/_delete_by_query`
  with `{ "query": … }` (and a `script` for update_by_query).

## Move / alias (write)

- Reindex: `POST /_reindex` with `{ "source": { "index": "a" }, "dest": { "index": "b" } }`.
- Aliases: `POST /_aliases` with `{ "actions": [ { "add": { "index": "a", "alias": "live" } } ] }`.

Prefer the smallest correct call. For "create an index for X" give a mapping with sensible
types inferred from the described fields; do not add fields the user didn't mention.
