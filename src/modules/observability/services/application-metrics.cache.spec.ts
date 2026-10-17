jest.mock('@kubernetes/client-node', () => ({}));

import {
  ApplicationMetricsService,
  instantCacheTtlMs,
} from './application-metrics.service';
import { AppMetricsDto } from '../dto/application-metrics.dto';

describe('instantCacheTtlMs', () => {
  it('defaults to thirty seconds', () => {
    expect(instantCacheTtlMs(undefined)).toBe(30_000);
    expect(instantCacheTtlMs('')).toBe(30_000);
    expect(instantCacheTtlMs('soon')).toBe(30_000);
  });

  it('reads seconds, and zero turns the cache off', () => {
    expect(instantCacheTtlMs('10')).toBe(10_000);
    expect(instantCacheTtlMs('0')).toBe(0);
  });
});

describe('ApplicationMetricsService instant cache', () => {
  const build = () => {
    const service = new ApplicationMetricsService(
      {} as never,
      {} as never,
      {} as never,
    );
    const query = jest.fn(
      async (appId: string) => ({ app_id: appId }) as unknown as AppMetricsDto,
    );
    (
      service as unknown as { queryAppMetricsInstant: typeof query }
    ).queryAppMetricsInstant = query;
    return { service, query };
  };

  afterEach(() => {
    delete process.env.METRICS_INSTANT_CACHE_SECONDS;
    jest.useRealTimers();
  });

  it('answers many viewers of one application with one round of queries', async () => {
    const { service, query } = build();

    await Promise.all(
      Array.from({ length: 50 }, () =>
        service.getAppMetricsInstant('a1', 'web', 'ns'),
      ),
    );

    expect(query).toHaveBeenCalledTimes(1);
  });

  it('asks again once the answer is older than the window', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { service, query } = build();

    await service.getAppMetricsInstant('a1', 'web', 'ns');
    jest.setSystemTime(1_000_000 + 29_999);
    await service.getAppMetricsInstant('a1', 'web', 'ns');
    expect(query).toHaveBeenCalledTimes(1);
    jest.setSystemTime(1_000_000 + 30_001);
    await service.getAppMetricsInstant('a1', 'web', 'ns');

    expect(query).toHaveBeenCalledTimes(2);
  });

  it('keeps applications apart', async () => {
    const { service, query } = build();

    await service.getAppMetricsInstant('a1', 'web', 'ns');
    await service.getAppMetricsInstant('a2', 'api', 'ns');

    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not remember a failure', async () => {
    const { service, query } = build();
    query.mockRejectedValueOnce(new Error('prometheus down'));

    await expect(
      service.getAppMetricsInstant('a1', 'web', 'ns'),
    ).rejects.toThrow('prometheus down');
    await service.getAppMetricsInstant('a1', 'web', 'ns');

    expect(query).toHaveBeenCalledTimes(2);
  });

  it('can be turned off', async () => {
    process.env.METRICS_INSTANT_CACHE_SECONDS = '0';
    const { service, query } = build();

    await service.getAppMetricsInstant('a1', 'web', 'ns');
    await service.getAppMetricsInstant('a1', 'web', 'ns');

    expect(query).toHaveBeenCalledTimes(2);
  });
});

describe('ApplicationMetricsService queries behind the caches', () => {
  const empty = {
    status: 'success',
    data: { resultType: 'vector', result: [] },
  };
  const build = () => {
    const prometheus = {
      queryInstant: jest.fn(async (..._args: unknown[]) => empty),
      queryRange: jest.fn(async (..._args: unknown[]) => ({
        status: 'success',
        data: { resultType: 'matrix', result: [] },
      })),
    };
    const resources = {
      findByApplicationId: jest.fn(async () => []),
      findByApplicationIdAndKind: jest.fn(async () => [{ name: 'data-web-0' }]),
    };
    const service = new ApplicationMetricsService(
      prometheus as never,
      { findById: async () => ({ clusterId: 'c1' }) } as never,
      resources as never,
    );
    return { service, prometheus, resources };
  };

  afterEach(() => jest.useRealTimers());

  it('keeps the disk reading inside the shared instant answer', async () => {
    const { service, prometheus, resources } = build();

    await service.getAppMetricsInstant('a1', 'web', 'ns');
    const asked = prometheus.queryInstant.mock.calls.length;
    await service.getAppMetricsInstant('a1', 'web', 'ns');

    expect(
      prometheus.queryInstant.mock.calls.some(([q]) =>
        String(q).includes('kubelet_volume_stats_used_bytes'),
      ),
    ).toBe(true);
    expect(prometheus.queryInstant).toHaveBeenCalledTimes(asked);
    expect(resources.findByApplicationIdAndKind).toHaveBeenCalledTimes(1);
  });

  it('shares one history among viewers a few seconds apart', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { service, prometheus } = build();

    await Promise.all([
      service.getAppMetricsHistory(
        'a1',
        'web',
        'ns',
        996_403,
        1_000_003,
        '60s',
      ),
      service.getAppMetricsHistory(
        'a1',
        'web',
        'ns',
        996_417,
        1_000_017,
        '60s',
      ),
    ]);
    const asked = prometheus.queryRange.mock.calls.length;
    jest.setSystemTime(1_000_000 + 20_000);
    await service.getAppMetricsHistory(
      'a1',
      'web',
      'ns',
      996_419,
      1_000_019,
      '60s',
    );

    expect(prometheus.queryRange).toHaveBeenCalledTimes(asked);
    expect(prometheus.queryRange.mock.calls[0].slice(1)).toEqual([
      996_390,
      999_990,
      '60s',
    ]);
  });

  it('asks again for another step, another application, or after the window', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { service, prometheus } = build();
    const history = (appId: string, step: string) =>
      service.getAppMetricsHistory(appId, 'web', 'ns', 0, 3_600, step);

    await history('a1', '60s');
    const once = prometheus.queryRange.mock.calls.length;
    await history('a1', '5m');
    await history('a2', '60s');
    expect(prometheus.queryRange).toHaveBeenCalledTimes(once * 3);

    jest.setSystemTime(1_000_000 + 30_000);
    await history('a1', '60s');
    expect(prometheus.queryRange).toHaveBeenCalledTimes(once * 4);
  });

  it('does not remember a failed history', async () => {
    const { service, prometheus } = build();
    prometheus.queryRange.mockRejectedValueOnce(new Error('prometheus down'));

    await expect(
      service.getAppMetricsHistory('a1', 'web', 'ns', 0, 3_600, '60s'),
    ).rejects.toThrow('prometheus down');
    await expect(
      service.getAppMetricsHistory('a1', 'web', 'ns', 0, 3_600, '60s'),
    ).resolves.toEqual([]);
  });
});
