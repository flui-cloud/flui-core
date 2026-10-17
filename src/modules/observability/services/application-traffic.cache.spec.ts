import { ApplicationTrafficService } from './application-traffic.service';

describe('ApplicationTrafficService history cache', () => {
  const target = { slug: 'web', namespace: 'ns', port: 8080 };
  const build = () => {
    const queryRange = jest.fn(async () => ({
      status: 'success',
      data: { resultType: 'matrix', result: [] },
    }));
    const service = new ApplicationTrafficService({ queryRange } as never);
    return { service, queryRange };
  };

  afterEach(() => jest.useRealTimers());

  it('shares one history among viewers a few seconds apart', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { service, queryRange } = build();

    await Promise.all([
      service.getTrafficHistory(target, 996_403, 1_000_003, '60s', '5m'),
      service.getTrafficHistory(target, 996_417, 1_000_017, '60s', '5m'),
    ]);
    jest.setSystemTime(1_000_000 + 29_000);
    await service.getTrafficHistory(target, 996_419, 1_000_019, '60s', '5m');

    expect(queryRange).toHaveBeenCalledTimes(4);
    expect((queryRange.mock.calls[0] as unknown[]).slice(1)).toEqual([
      996_390,
      999_990,
      '60s',
    ]);
  });

  it('asks again for another window, another application, or after 30 s', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    const { service, queryRange } = build();

    await service.getTrafficHistory(target, 0, 3_600, '60s', '5m');
    await service.getTrafficHistory(target, 0, 3_600, '60s', '1m');
    await service.getTrafficHistory(
      { ...target, slug: 'api' },
      0,
      3_600,
      '60s',
      '5m',
    );
    expect(queryRange).toHaveBeenCalledTimes(12);

    jest.setSystemTime(1_000_000 + 30_000);
    await service.getTrafficHistory(target, 0, 3_600, '60s', '5m');
    expect(queryRange).toHaveBeenCalledTimes(16);
  });

  it('asks nothing for an application without an HTTP route', async () => {
    const { service, queryRange } = build();

    await expect(
      service.getTrafficHistory(
        { slug: 'db', namespace: 'ns', port: 5432, portProtocol: 'tcp' },
        0,
        3_600,
        '60s',
        '5m',
      ),
    ).resolves.toEqual([]);
    expect(queryRange).not.toHaveBeenCalled();
  });
});
