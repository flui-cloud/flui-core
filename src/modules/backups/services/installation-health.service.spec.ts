import { InstallationHealthService } from './installation-health.service';

describe('InstallationHealthService', () => {
  const vector = (available: Record<string, number>) => ({
    status: 'success',
    data: {
      resultType: 'vector',
      result: Object.entries(available).map(([deployment, n]) => ({
        metric: { deployment },
        value: [0, String(n)],
      })),
    },
  });

  const build = (opts: {
    db?: () => Promise<unknown>;
    metrics?: () => Promise<unknown>;
  }) =>
    new InstallationHealthService(
      { query: jest.fn(opts.db ?? (async () => [{ '?column?': 1 }])) } as never,
      {
        queryInstant: jest.fn(
          opts.metrics ?? (async () => vector({ alertmanager: 1, vmalert: 1 })),
        ),
      } as never,
    );

  it('is healthy when the database answers and the alert pipeline runs', async () => {
    await expect(build({}).check()).resolves.toEqual({
      healthy: true,
      problems: [],
    });
  });

  it('names each piece of the alert pipeline that is not running', async () => {
    const health = await build({
      metrics: async () => vector({ alertmanager: 0 }),
    }).check();
    expect(health.healthy).toBe(false);
    expect(health.problems).toEqual([
      'alertmanager has no running copy, so alerts would not be delivered',
      'vmalert has no running copy, so alerts would not be delivered',
    ]);
  });

  it('reports a database and a metrics store that do not answer', async () => {
    const health = await build({
      db: async () => {
        throw new Error('connection refused');
      },
      metrics: async () => {
        throw new Error('Prometheus query failed: timeout');
      },
    }).check();
    expect(health.problems).toEqual([
      'The database does not answer: connection refused',
      'The metrics store does not answer: Prometheus query failed: timeout',
    ]);
  });
});
