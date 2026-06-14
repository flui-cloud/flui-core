---
title: Common tasks
---

Map the request to the smallest command that answers it.

- **"how many keys are there?"** → `DBSIZE`.
- **"find the session keys" / "keys like X"** → `SCAN 0 MATCH session:* COUNT 100`
  (cursor-based; the console pages with the returned cursor).
- **"show the value of key X"** → first the type decides the command: a hash → `HGETALL X`,
  a string → `GET X`, a list → `LRANGE X 0 -1`, a set → `SMEMBERS X`, a zset →
  `ZRANGE X 0 -1 WITHSCORES`. If the type is unknown, `TYPE X` first.
- **"when does X expire?"** → `TTL X` (seconds) or `PTTL X` (ms).
- **"top N of a leaderboard X"** → `ZRANGE X 0 N-1 REV WITHSCORES`.
- **"is member M in set X?"** → `SISMEMBER X M`.
- **"how big is X?"** → `STRLEN`/`HLEN`/`LLEN`/`SCARD`/`ZCARD` by type.
- **"memory used by X"** → `MEMORY USAGE X`.

Writes (only on explicit request — warn that they change data):

- **"set X to V for 1 hour"** → `SET X V EX 3600`.
- **"delete X"** → `DEL X` (destructive — confirm scope; for a pattern, `SCAN` first and review).
- **"expire X in 10 minutes"** → `EXPIRE X 600`.

Never run `KEYS *` or `FLUSHALL`/`FLUSHDB` unless the user asks for exactly that.
