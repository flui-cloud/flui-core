jest.mock('@kubernetes/client-node', () => ({}));

import {
  ApplicationMetricsService,
  instantCacheTtlMs,
} from './application-metrics.service';
import { AppMetricsDto } from '../dto/application-metrics.dto';

describe('instantCacheTtlMs', () => {
  it('defaults to ten seconds', () => {
    expect(instantCacheTtlMs(undefined)).toBe(10_000);
    expect(instantCacheTtlMs('')).toBe(10_000);
    expect(instantCacheTtlMs('soon')).toBe(10_000);
  });

  it('reads seconds, and zero turns the cache off', () => {
    expect(instantCacheTtlMs('30')).toBe(30_000);
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
    jest.setSystemTime(1_000_000 + 10_001);
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
