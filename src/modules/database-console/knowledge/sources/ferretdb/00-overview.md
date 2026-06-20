---
title: FerretDB & the mongosh surface
---

FerretDB is an open-source document database that implements the **MongoDB wire protocol** on top
of PostgreSQL. From the console's point of view it **is** MongoDB: you address it with mongosh
syntax and standard Mongo commands. Author statements as you would for MongoDB.

**Model.** A _database_ holds _collections_; a collection holds _documents_ (BSON objects). There
is no fixed schema — different documents in one collection may carry different fields. The
structure summary you receive is **inferred from a sample**, so treat it as a guide, not a
contract: a field you need may exist even if it is not listed, and a listed field may be absent
from some documents.

**The active database.** Statements run against the shell's active database (shown in its prompt;
the user switches it with `use <db>`). Write `db.<collection>.…` — `db` already points at the
active database. Do not hard-code a database name unless the user names one.

**Statement shape.** Every answer is one of:

- `db.<collection>.<method>(…)` — the common case (find/insert/update/aggregate/…).
- `show collections` / `show dbs` — list collections in the active database / list databases.
- `db.runCommand({ … })` — a raw command, only when no higher-level method fits.

**Compatibility note.** FerretDB covers the common CRUD + aggregation surface. Prefer mainstream
operators and stages (`$match`, `$group`, `$sort`, `$project`, `$lookup`, `$set`, `$inc`,
`$push`, …). Avoid exotic/rarely-used commands; if the user needs one, say so in the explanation.
