import { PromiseCache, alignRange } from './promise-cache';

describe('PromiseCache', () => {
  afterEach(() => jest.useRealTimers());

  const build = (ttlMs = 30_000, max = 500) => {
    const cache = new PromiseCache<string>(() => ttlMs, max);
    const load = jest.fn(async () => 'answer');
    return { cache, load };
  };

  it('answers from memory within the window', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { cache, load } = build();

    await cache.get('k', load);
    jest.setSystemTime(1_000_000 + 29_999);
    await cache.get('k', load);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it('asks again once the answer is older than the window', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { cache, load } = build();

    await cache.get('k', load);
    jest.setSystemTime(1_000_000 + 30_000);
    await cache.get('k', load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('lets concurrent callers share one load', async () => {
    const { cache, load } = build();

    const answers = await Promise.all(
      Array.from({ length: 20 }, () => cache.get('k', load)),
    );

    expect(load).toHaveBeenCalledTimes(1);
    expect(new Set(answers).size).toBe(1);
  });

  it('does not remember a failure', async () => {
    const { cache, load } = build();
    load.mockRejectedValueOnce(new Error('prometheus down'));

    await expect(cache.get('k', load)).rejects.toThrow('prometheus down');
    await expect(cache.get('k', load)).resolves.toBe('answer');

    expect(load).toHaveBeenCalledTimes(2);
  });

  it('loads every time when the window is zero', async () => {
    const { cache, load } = build(0);

    await cache.get('k', load);
    await cache.get('k', load);

    expect(load).toHaveBeenCalledTimes(2);
    expect(cache.size).toBe(0);
  });

  it('drops the oldest key past the cap', async () => {
    const { cache, load } = build(30_000, 2);

    await cache.get('a', load);
    await cache.get('b', load);
    await cache.get('c', load);
    expect(cache.size).toBe(2);

    await cache.get('b', load);
    await cache.get('c', load);
    expect(load).toHaveBeenCalledTimes(3);
    await cache.get('a', load);
    expect(load).toHaveBeenCalledTimes(4);
  });

  it('drops expired keys when it loads', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { cache, load } = build();

    await cache.get('a', load);
    await cache.get('b', load);
    jest.setSystemTime(1_000_000 + 30_000);
    await cache.get('c', load);

    expect(cache.size).toBe(1);
  });
});

describe('alignRange', () => {
  it('gives viewers a few seconds apart the same range', () => {
    expect(alignRange(1_000_003, 1_003_603, 30)).toEqual(
      alignRange(1_000_017, 1_003_617, 30),
    );
    expect(alignRange(1_000_017, 1_003_617, 30)).toEqual({
      start: 999_990,
      end: 1_003_590,
    });
  });
});
