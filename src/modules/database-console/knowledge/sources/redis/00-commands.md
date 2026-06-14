---
title: Command quick reference by type
---

Pick the command from the key's type (the summary shows the type breakdown; `TYPE <key>` tells
you a specific key's type). Reads are safe; writes only on explicit request.

**Keys / generic**

- `TYPE key` · `TTL key` (seconds; -1 no expire, -2 missing) · `PTTL key` (ms) · `EXISTS key`
- `SCAN 0 MATCH pattern COUNT 100` — cursor-based key iteration (use instead of `KEYS`).
- `OBJECT ENCODING key` · `MEMORY USAGE key`
- Writes: `DEL key` · `UNLINK key` (async del) · `EXPIRE key seconds` · `PERSIST key` · `RENAME a b`

**String**

- `GET key` · `MGET k1 k2` · `STRLEN key` · `GETRANGE key 0 -1`
- Writes: `SET key value` · `SET key value EX 60` · `INCR key` · `APPEND key v`

**Hash**

- `HGETALL key` · `HGET key field` · `HMGET key f1 f2` · `HKEYS key` · `HVALS key` · `HLEN key`
- Writes: `HSET key field value` · `HDEL key field`

**List**

- `LRANGE key 0 -1` (all) · `LRANGE key 0 99` · `LLEN key` · `LINDEX key 0`
- Writes: `LPUSH key v` · `RPUSH key v` · `LPOP key` · `LREM key 0 v`

**Set**

- `SMEMBERS key` · `SCARD key` · `SISMEMBER key member` · `SSCAN key 0 COUNT 100`
- Writes: `SADD key member` · `SREM key member`

**Sorted set (zset)**

- `ZRANGE key 0 -1 WITHSCORES` · `ZRANGE key 0 -1 REV WITHSCORES` (top) · `ZCARD key`
- `ZSCORE key member` · `ZRANGEBYSCORE key min max`
- Writes: `ZADD key score member` · `ZREM key member`

**Server / keyspace**

- `DBSIZE` · `INFO keyspace` · `INFO memory` · `PING`
