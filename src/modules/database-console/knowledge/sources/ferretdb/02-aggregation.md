---
title: Aggregation pipelines
---

`db.<coll>.aggregate([ <stage>, <stage>, … ])` runs documents through an ordered pipeline. Use it
for grouping, counting-by-key, joins, and computed fields — anything `find` can't express.

**Common stages**

- `$match` — filter (same syntax as a find filter); put it first to cut the working set:
  `{ $match: { status: "paid" } }`
- `$group` — aggregate by a key; `_id` is the grouping key, the rest are accumulators
  (`$sum`, `$avg`, `$min`, `$max`, `$count`, `$push`, `$addToSet`):
  `{ $group: { _id: "$category", total: { $sum: "$price" }, n: { $sum: 1 } } }`
- `$sort` — `{ $sort: { total: -1 } }`
- `$limit` / `$skip` — `{ $limit: 10 }`
- `$project` — reshape: `{ $project: { name: 1, year: { $year: "$createdAt" }, _id: 0 } }`
- `$count` — `{ $count: "documents" }`
- `$unwind` — flatten an array field into one document per element: `{ $unwind: "$items" }`
- `$lookup` — left-outer join another collection:
  `{ $lookup: { from: "users", localField: "userId", foreignField: "_id", as: "user" } }`

**Worked examples**

Count documents per category, highest first:

```
db.products.aggregate([
  { $group: { _id: "$category", count: { $sum: 1 } } },
  { $sort: { count: -1 } }
])
```

Total revenue per day from paid orders:

```
db.orders.aggregate([
  { $match: { status: "paid" } },
  { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, revenue: { $sum: "$amount" } } },
  { $sort: { _id: 1 } }
])
```

**Note.** `$out` and `$merge` WRITE a collection, so a pipeline ending in either is a write (gated
by read-only). Plain aggregations are reads.
