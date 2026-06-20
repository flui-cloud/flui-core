---
title: BSON types & constructors
---

Documents hold typed BSON values. Match and insert them with the mongosh constructors — the shell
parses these into real BSON, so they round-trip exactly. Using the right constructor matters: a
string `"652c…"` does NOT match an `ObjectId("652c…")`.

**Constructors**

- `ObjectId("652c8f1e…")` — the 24-hex `_id` type. Match by id:
  `db.users.find({ _id: ObjectId("652c8f1e2a4b1c0007a1b2c3") })`
- `ISODate("2024-01-31T00:00:00Z")` — a date/time. Range:
  `db.events.find({ createdAt: { $gte: ISODate("2024-01-01") } })`
- `NumberDecimal("19.99")` — exact decimal (money). `NumberLong("9007199254740993")` — 64-bit int
  beyond the safe JS range. `NumberInt("42")` — 32-bit int.
- `/pattern/flags` or `{ $regex: "…", $options: "i" }` — regex match:
  `db.users.find({ email: { $regex: "@example\\.com$", $options: "i" } })`

**How the console shows them.** Results render these as MongoDB-tool tokens — `ObjectId('…')`,
`ISODate('…')`, `Long('…')`, `Decimal128('…')` — exactly like Compass/mongosh, so what you see
matches what you'd type.

**Type-aware operators**

- `$type`: `db.docs.find({ value: { $type: "string" } })` (also "double", "object", "array",
  "objectId", "date", "decimal", "long", "int", "bool", "null", "binData").
- Null vs missing: `{ field: null }` matches null **and** missing; use `{ field: { $exists: false } }`
  for missing only, `{ field: { $ne: null } }` for present-and-not-null.

**Field update operators** (used in update statements)

- `$set` (set/overwrite), `$unset` (remove), `$inc` (add to number), `$mul` (multiply)
- `$push` / `$pull` / `$addToSet` (array element add/remove/add-if-absent)
- `$rename`, `$min`, `$max`, `$currentDate`
