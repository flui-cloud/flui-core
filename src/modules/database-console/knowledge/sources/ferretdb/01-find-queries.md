---
title: Reading documents (find / findOne)
---

`db.<coll>.find(<filter>, <projection>)` returns matching documents; `findOne` returns the first
match (or null). An empty/omitted filter matches everything.

**Filter basics**

- Equality: `db.users.find({ status: "active" })`
- Nested path (dot notation): `db.orders.find({ "address.city": "Rome" })`
- Multiple conditions are AND: `db.users.find({ status: "active", role: "admin" })`

**Comparison operators**

- `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`
  `db.products.find({ price: { $gte: 10, $lt: 50 } })`
- `$in`, `$nin`: `db.users.find({ role: { $in: ["admin", "editor"] } })`

**Logical / element**

- `$or`, `$and`, `$nor`, `$not`:
  `db.users.find({ $or: [ { role: "admin" }, { verified: true } ] })`
- `$exists`: `db.users.find({ deletedAt: { $exists: false } })`
- `$type`: `db.events.find({ payload: { $type: "object" } })`

**Arrays**

- Match an element: `db.posts.find({ tags: "mongodb" })` (matches if `tags` contains it)
- `$all` (contains all), `$size` (exact length), `$elemMatch` (one element matches all conditions):
  `db.posts.find({ tags: { $all: ["db", "ferret"] } })`
  `db.orders.find({ items: { $elemMatch: { sku: "A1", qty: { $gt: 1 } } } })`

**Shaping the result (cursor modifiers, chain after find)**

- `.sort({ createdAt: -1 })` — -1 desc, 1 asc
- `.limit(20)` — cap rows (a plain `find()` already pages to 20; widen with `.limit(n)`)
- `.skip(40)` — offset
- `.projection({ name: 1, _id: 0 })` — include/exclude fields (also as find's 2nd argument)

Example: `db.users.find({ role: "admin" }, { name: 1, email: 1, _id: 0 }).sort({ name: 1 }).limit(10)`

**Matching an id / date** — use the constructors (see the types section):
`db.users.find({ _id: ObjectId("652c…") })` · `db.events.find({ at: { $gte: ISODate("2024-01-01") } })`
