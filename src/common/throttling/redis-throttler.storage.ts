import { Logger } from '@nestjs/common';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { ThrottlerStorageRecord } from '@nestjs/throttler/dist/throttler-storage-record.interface';
import Redis from 'ioredis';

/** Count, then block once over the limit; while blocked, nothing is counted. */
const INCREMENT = `
local blocked = redis.call('PTTL', KEYS[2])
if blocked > 0 then
  return {tonumber(redis.call('GET', KEYS[1]) or '0'), redis.call('PTTL', KEYS[1]), blocked}
end
local hits = redis.call('INCR', KEYS[1])
if hits == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if hits > tonumber(ARGV[2]) and tonumber(ARGV[3]) > 0 then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  return {hits, ttl, tonumber(ARGV[3])}
end
return {hits, ttl, 0}
`;

/**
 * Rate limits counted in Redis, so they hold across every copy of the API:
 * counted per process, N copies would let N times the limit through. When
 * Redis does not answer, the count falls back to this copy alone rather than
 * refusing the request.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly local = new ThrottlerStorageService();

  private client: Redis | null = null;

  constructor(private readonly connect: () => Redis) {}

  private get redis(): Redis {
    this.client ??= this.connect();
    return this.client;
  }

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    const base = `flui:throttle:${throttlerName}:${key}`;
    try {
      const [hits, ttlMs, blockMs] = (await this.redis.eval(
        INCREMENT,
        2,
        base,
        `${base}:blocked`,
        String(ttl),
        String(limit),
        String(blockDuration),
      )) as [number, number, number];
      return {
        totalHits: hits,
        timeToExpire: Math.max(Math.ceil(ttlMs / 1000), 0),
        isBlocked: blockMs > 0,
        timeToBlockExpire: Math.max(Math.ceil(blockMs / 1000), 0),
      };
    } catch (error) {
      this.logger.warn(
        `Counting this request locally, Redis did not answer: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return this.local.increment(
        key,
        ttl,
        limit,
        blockDuration,
        throttlerName,
      );
    }
  }
}

let shared: RedisThrottlerStorage | null = null;

/** One storage, and one Redis client made on the first request, for every module's limits. */
export function sharedThrottlerStorage(): RedisThrottlerStorage {
  shared ??= new RedisThrottlerStorage(
    () =>
      new Redis({
        host: process.env.REDIS_HOST || 'localhost',
        port: Number.parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
      }),
  );
  return shared;
}
