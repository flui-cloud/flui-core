---
title: Shell helpers & inspection
---

Beyond CRUD, these statements help explore a store you don't know yet. They are all reads.

**Listing**

- `show dbs` — databases (with sizes).
- `show collections` — collections in the active database.
- `db.getCollectionNames()` — same list, as an array.

**Counting & sampling**

- `db.<coll>.countDocuments({ … })` — exact count of matches (`{}` for the whole collection).
- `db.<coll>.estimatedDocumentCount()` — fast metadata estimate (no filter).
- `db.<coll>.distinct("field", { … })` — distinct values of a field (optionally filtered):
  `db.orders.distinct("status")`
- `db.<coll>.findOne()` — peek at one document to learn the shape.

**Indexes & stats**

- `db.<coll>.getIndexes()` — indexes on a collection.
- `db.stats()` — database-level stats.

**Raw commands (escape hatch)**

When no higher-level method fits, run the underlying command directly:

- `db.runCommand({ collStats: "users" })`
- `db.runCommand({ ping: 1 })`

Prefer the method form (`db.coll.find(…)`) when one exists — it's what mongosh users expect and
it reads more clearly than the equivalent raw command.
