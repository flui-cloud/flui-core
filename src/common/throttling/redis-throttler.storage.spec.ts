import { RedisThrottlerStorage } from './redis-throttler.storage';

/** Redis as far as the script needs it, shared by every copy of the API. */
const fakeRedis = () => {
  const counts = new Map<string, number>();
  const blocked = new Set<string>();
  return {
    eval: async (
      _s: string,
      _n: number,
      key: string,
      blockKey: string,
      _ttl: string,
      limit: string,
    ) => {
      if (blocked.has(blockKey)) return [counts.get(key) ?? 0, 60_000, 30_000];
      const hits = (counts.get(key) ?? 0) + 1;
      counts.set(key, hits);
      if (hits > Number(limit)) {
        blocked.add(blockKey);
        return [hits, 60_000, 30_000];
      }
      return [hits, 60_000, 0];
    },
  };
};

describe('rate limits shared by every copy of the API', () => {
  it('counts the requests that reach different copies together', async () => {
    const redis = fakeRedis();
    const a = new RedisThrottlerStorage(() => redis as never);
    const b = new RedisThrottlerStorage(() => redis as never);
    await a.increment('ip:1', 60_000, 2, 30_000, 'default');
    await b.increment('ip:1', 60_000, 2, 30_000, 'default');
    const third = await a.increment('ip:1', 60_000, 2, 30_000, 'default');
    expect(third).toMatchObject({
      totalHits: 3,
      isBlocked: true,
      timeToBlockExpire: 30,
    });
    expect(
      await b.increment('ip:1', 60_000, 2, 30_000, 'default'),
    ).toMatchObject({ isBlocked: true });
  });

  it('counts locally when Redis does not answer, rather than refusing', async () => {
    const storage = new RedisThrottlerStorage(
      () =>
        ({
          eval: async () => {
            throw new Error('ECONNREFUSED');
          },
        }) as never,
    );
    const record = await storage.increment(
      'ip:1',
      60_000,
      5,
      60_000,
      'default',
    );
    expect(record.totalHits).toBe(1);
    expect(record.isBlocked).toBe(false);
  });
});
