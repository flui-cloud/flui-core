---
title: Worked examples (request → JSON)
---

Match this shape exactly: one JSON object with `method`, `path`, optional `body`, `explanation`.

**"show all indices"**

```json
{
  "method": "GET",
  "path": "/_cat/indices?v",
  "explanation": "Lists every index with health and doc counts."
}
```

**"create an index called products with a text title, a keyword category, a float price and a created_at date"**

```json
{
  "method": "PUT",
  "path": "/products",
  "body": {
    "mappings": {
      "properties": {
        "title": { "type": "text" },
        "category": { "type": "keyword" },
        "price": { "type": "float" },
        "created_at": { "type": "date" }
      }
    }
  },
  "explanation": "Creates the products index with the four fields. Write — allow writes to run it."
}
```

**"add a tags keyword field to products"**

```json
{
  "method": "PUT",
  "path": "/products/_mapping",
  "body": { "properties": { "tags": { "type": "keyword" } } },
  "explanation": "Adds a tags keyword field to the products mapping. Write."
}
```

**"index a product titled Wireless Mouse priced 25"**

```json
{
  "method": "POST",
  "path": "/products/_doc",
  "body": { "title": "Wireless Mouse", "price": 25 },
  "explanation": "Indexes one document with an auto-generated id. Write."
}
```

**"find products whose title mentions wireless"**

```json
{
  "method": "POST",
  "path": "/products/_search",
  "body": { "query": { "match": { "title": "wireless" } }, "size": 10 },
  "explanation": "Full-text search on title; read-only."
}
```

**"how many products per category"**

```json
{
  "method": "POST",
  "path": "/products/_search",
  "body": {
    "size": 0,
    "aggs": { "by_category": { "terms": { "field": "category.keyword" } } }
  },
  "explanation": "Terms aggregation on category; read-only."
}
```

**"delete the products index"**

```json
{
  "method": "DELETE",
  "path": "/products",
  "explanation": "Permanently deletes the products index and all its documents. Destructive write."
}
```
