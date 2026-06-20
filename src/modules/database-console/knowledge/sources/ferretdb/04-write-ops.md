---
title: Writing documents (gated)
---

Writes run only after the operator disables read-only and confirms. Emit one **only** when the
user clearly asks to change data, and warn in the explanation. Always scope writes with a filter —
never an empty filter on `updateMany`/`deleteMany` unless the user explicitly asks to touch every
document.

**Insert**

- `db.users.insertOne({ name: "Ada", role: "admin", createdAt: ISODate("2024-01-01") })`
- `db.users.insertMany([ { name: "A" }, { name: "B" } ])`

**Update** — filter first, then a modifier document built from update operators (`$set`, `$inc`, …):

- One: `db.users.updateOne({ _id: ObjectId("652c…") }, { $set: { role: "editor" } })`
- Many: `db.orders.updateMany({ status: "pending" }, { $set: { status: "cancelled" } })`
- Increment: `db.products.updateOne({ sku: "A1" }, { $inc: { stock: -1 } })`
- Add to array: `db.posts.updateOne({ _id: ObjectId("…") }, { $push: { tags: "featured" } })`
- Upsert (insert if no match): pass `{ upsert: true }` as the 3rd argument.
- Replace the whole document (no operators): `db.users.replaceOne({ _id: ObjectId("…") }, { name: "Ada", role: "admin" })`

**Delete**

- One: `db.sessions.deleteOne({ token: "abc" })`
- Many: `db.events.deleteMany({ createdAt: { $lt: ISODate("2023-01-01") } })`

**Indexes / collections** (administrative writes)

- `db.users.createIndex({ email: 1 }, { unique: true })`
- `db.users.getIndexes()` (this one is a read)
- `db.tmp.drop()` — drops a whole collection (destructive; only on explicit request).

**Safety pattern.** When a delete/update scope is fuzzy, first return the matching read
(`db.coll.countDocuments({ … })` or `find`) so the operator can verify the blast radius, and say
in the explanation that the write follows once they confirm the count.
