import { countOrRefuse } from './per-key-limit';

describe('countOrRefuse', () => {
  const rule = {
    name: 'test',
    ttlMs: 60_000,
    limit: 2,
    code: 'TOO_MANY',
    message: 'Slow down.',
  };
  const storage = () => {
    const hits = new Map<string, number>();
    return {
      increment: jest.fn(async (key: string) => {
        hits.set(key, (hits.get(key) ?? 0) + 1);
        return {
          totalHits: hits.get(key)!,
          timeToExpire: 42,
          isBlocked: false,
          timeToBlockExpire: 0,
        };
      }),
    };
  };

  it('lets a key through up to its limit, then refuses it alone', async () => {
    const s = storage();
    await countOrRefuse(s, 'a', rule);
    await countOrRefuse(s, 'a', rule);
    await expect(countOrRefuse(s, 'a', rule)).rejects.toMatchObject({
      status: 429,
      response: { code: 'TOO_MANY', retryAfterSeconds: 42 },
    });
    await countOrRefuse(s, 'b', rule);
    expect(s.increment).toHaveBeenCalledWith('a', 60_000, 2, 0, 'test');
  });
});
