---
title: Worked examples (request → JSON)
---

Each example assumes the relevant index/fields appear in the live structure. Match this shape
exactly: one JSON object with `index`, `body`, `explanation`.

**"find products whose title mentions wireless, cheapest first, top 10"**

```json
{
  "index": "products",
  "body": {
    "query": { "match": { "title": "wireless" } },
    "sort": [{ "price": "asc" }],
    "size": 10
  },
  "explanation": "Full-text match on title, sorted by ascending price, first 10."
}
```

**"active users created in the last 7 days"**

```json
{
  "index": "users",
  "body": {
    "query": {
      "bool": {
        "filter": [
          { "term": { "status.keyword": "active" } },
          { "range": { "created_at": { "gte": "now-7d/d" } } }
        ]
      }
    },
    "size": 20
  },
  "explanation": "Boolean filter: active status and created within the last 7 days."
}
```

**"how many orders per status"**

```json
{
  "index": "orders",
  "body": {
    "size": 0,
    "aggs": {
      "by_status": { "terms": { "field": "status.keyword", "size": 20 } }
    }
  },
  "explanation": "Terms aggregation on status; size 0 since only counts are needed."
}
```

**"average order total per day this month"**

```json
{
  "index": "orders",
  "body": {
    "size": 0,
    "query": { "range": { "created_at": { "gte": "now/M" } } },
    "aggs": {
      "per_day": {
        "date_histogram": { "field": "created_at", "calendar_interval": "day" },
        "aggs": { "avg_total": { "avg": { "field": "total" } } }
      }
    }
  },
  "explanation": "Filter to this month, bucket by day, average the total in each bucket."
}
```

**"laptops under 1500 in stock, not discontinued"**

```json
{
  "index": "products",
  "body": {
    "query": {
      "bool": {
        "must": [{ "match": { "title": "laptop" } }],
        "filter": [
          { "range": { "price": { "lte": 1500 } } },
          { "term": { "in_stock": true } }
        ],
        "must_not": [{ "term": { "discontinued": true } }]
      }
    },
    "size": 20
  },
  "explanation": "Scored title match, with price/stock filters and a discontinued exclusion."
}
```

**"delete the test index"** (refuse)

```json
{
  "index": "",
  "body": {},
  "explanation": "The search console is read-only — it can only run _search and _count, not delete or modify indices."
}
```
