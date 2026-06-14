import { BadRequestException, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { DbEngine } from '../interfaces/db-connection';
import { isReadOnlyCommand } from './redis-commands';
import {
  CommandResult,
  KeyMeta,
  KeyType,
  KeyValueConnection,
  KeyValueEngineAdapter,
  KeyValueRead,
  KeyspaceSummary,
  KvConnectParams,
  KvValue,
  ScanResult,
} from './keyvalue-engine';

const SUMMARY_SAMPLE = 200;

function asKeyType(t: string): KeyType {
  const known: KeyType[] = [
    'string',
    'list',
    'set',
    'zset',
    'hash',
    'stream',
    'none',
  ];
  return (known as string[]).includes(t) ? (t as KeyType) : 'none';
}

class RedisConnection implements KeyValueConnection {
  constructor(private readonly redis: Redis) {}

  // Counts only — never key names or values (data-blind keyspace overview).
  async summary(): Promise<KeyspaceSummary> {
    const keyCount = await this.redis.dbsize();
    const byType = new Map<string, number>();
    let cursor = '0';
    let sampled = 0;
    do {
      const [next, keys] = await this.redis.scan(cursor, 'COUNT', 100);
      cursor = next;
      if (keys.length) {
        const pipe = this.redis.pipeline();
        keys.forEach((k) => pipe.type(k));
        const res = await pipe.exec();
        res?.forEach(([err, t]) => {
          if (!err && typeof t === 'string')
            byType.set(t, (byType.get(t) ?? 0) + 1);
        });
        sampled += keys.length;
      }
    } while (cursor !== '0' && sampled < SUMMARY_SAMPLE);
    return {
      keyCount,
      sampled,
      byType: [...byType.entries()].map(([type, count]) => ({
        type: asKeyType(type),
        count,
      })),
    };
  }

  async scan(opts: {
    cursor: string;
    match?: string;
    count: number;
  }): Promise<ScanResult> {
    const args: (string | number)[] = [opts.cursor];
    if (opts.match) args.push('MATCH', opts.match);
    args.push('COUNT', opts.count);
    const [next, keys] = (await this.redis.scan(...(args as [string]))) as [
      string,
      string[],
    ];

    const keyMetas: KeyMeta[] = [];
    if (keys.length) {
      const pipe = this.redis.pipeline();
      keys.forEach((k) => pipe.type(k));
      keys.forEach((k) => pipe.ttl(k));
      const res = (await pipe.exec()) ?? [];
      keys.forEach((key, i) => {
        const type = res[i]?.[1];
        const ttl = res[keys.length + i]?.[1];
        keyMetas.push({
          key,
          type: asKeyType(typeof type === 'string' ? type : 'none'),
          ttl: typeof ttl === 'number' ? ttl : -1,
        });
      });
    }
    return { cursor: next, keys: keyMetas };
  }

  async readKey(
    key: string,
    opts: { maxElements: number },
  ): Promise<KeyValueRead> {
    const type = asKeyType(await this.redis.type(key));
    const ttl = await this.redis.ttl(key);
    const max = opts.maxElements;
    let value: KvValue;
    let length: number | undefined;
    let truncated = false;

    switch (type) {
      case 'string': {
        value = { kind: 'string', value: (await this.redis.get(key)) ?? '' };
        break;
      }
      case 'hash': {
        const all = await this.redis.hgetall(key);
        const fields = Object.entries(all).map(([field, v]) => ({
          field,
          value: v,
        }));
        length = fields.length;
        truncated = fields.length > max;
        value = {
          kind: 'hash',
          fields: truncated ? fields.slice(0, max) : fields,
        };
        break;
      }
      case 'list': {
        length = await this.redis.llen(key);
        truncated = length > max;
        value = {
          kind: 'list',
          items: await this.redis.lrange(key, 0, max - 1),
        };
        break;
      }
      case 'set': {
        const members = await this.redis.smembers(key);
        length = members.length;
        truncated = members.length > max;
        value = {
          kind: 'set',
          members: truncated ? members.slice(0, max) : members,
        };
        break;
      }
      case 'zset': {
        length = await this.redis.zcard(key);
        truncated = length > max;
        const flat = await this.redis.zrange(key, 0, max - 1, 'WITHSCORES');
        const entries: { member: string; score: number }[] = [];
        for (let i = 0; i < flat.length; i += 2) {
          entries.push({ member: flat[i], score: Number(flat[i + 1]) });
        }
        value = { kind: 'zset', entries };
        break;
      }
      default:
        value = {
          kind: 'other',
          note: `Type "${type}" is not previewable here yet.`,
        };
    }
    return { key, type, ttl, length, truncated, value };
  }

  async command(
    args: (string | number)[],
    opts: { readOnly: boolean },
  ): Promise<CommandResult> {
    const name = String(args[0] ?? '').toUpperCase();
    if (!name) throw new BadRequestException('Empty command');
    if (opts.readOnly && !isReadOnlyCommand(name)) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'READ_ONLY',
        message: `${name} is a write command — disable read-only to run it.`,
      });
    }
    const start = Date.now();
    try {
      const reply = await this.redis.call(name, ...args.slice(1).map(String));
      return { reply, durationMs: Date.now() - start };
    } catch (err) {
      throw mapRedisError(err);
    }
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

function mapRedisError(err: unknown): BadRequestException {
  const e = err as { message?: string };
  return new BadRequestException({
    statusCode: 400,
    code: 'REDIS_ERROR',
    message: e.message ?? 'command failed',
  });
}

@Injectable()
export class RedisEngineAdapter implements KeyValueEngineAdapter {
  // Redis and Valkey speak the same protocol — one adapter serves both.
  readonly engines: DbEngine[] = ['redis', 'valkey'];

  async connect(params: KvConnectParams): Promise<KeyValueConnection> {
    const redis = new Redis({
      host: params.host,
      port: params.port,
      // Empty/absent → connect anonymously (no-auth caches); never send AUTH with a blank password.
      password: params.credentials.password || undefined,
      lazyConnect: true,
      connectTimeout: 10_000,
      maxRetriesPerRequest: 1,
      // Fail fast instead of retrying forever behind the ephemeral tunnel.
      retryStrategy: () => null,
    });
    try {
      await redis.connect();
    } catch (err) {
      redis.disconnect();
      throw mapRedisError(err);
    }
    return new RedisConnection(redis);
  }
}
