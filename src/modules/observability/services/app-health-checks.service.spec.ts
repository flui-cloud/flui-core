jest.mock('@kubernetes/client-node', () => ({}));

import { countFailures } from './app-health-checks.service';

const NOW = Date.parse('2026-10-09T17:10:00Z');
const ev = (
  name: string,
  reason: string,
  message: string,
  at: string,
  count = 1,
) => ({
  reason,
  message,
  count,
  lastTimestamp: at,
  involvedObject: { kind: 'Pod', name },
});

describe("an application's failed health checks", () => {
  it('counts each kind of check the cluster recorded for its copies in the last hour', () => {
    const f = countFailures(
      [
        ev(
          'flui-api-6fc4b5d7db-7wgmd',
          'Unhealthy',
          'Readiness probe failed: Get "http://…": context deadline exceeded',
          '2026-10-09T16:59:20Z',
          4,
        ),
        ev(
          'flui-api-6fc4b5d7db-7wgmd',
          'Unhealthy',
          'Liveness probe failed: Get "http://…": context deadline exceeded',
          '2026-10-09T16:59:23Z',
          2,
        ),
        ev(
          'flui-api-76766995bf-nzkxs',
          'Unhealthy',
          'Startup probe failed: dial tcp: connect: connection refused',
          '2026-10-09T16:50:00Z',
        ),
        ev(
          'flui-api-76766995bf-nzkxs',
          'Unhealthy',
          'Readiness probe failed: Get "http://…": dial tcp …: connect: connection refused',
          '2026-10-09T16:50:05Z',
          3,
        ),
        ev(
          'flui-api-6fc4b5d7db-7wgmd',
          'Killing',
          'Container flui-api failed liveness probe, will be restarted',
          '2026-10-09T17:00:00Z',
        ),
      ],
      'flui-api',
      NOW,
    );
    expect(f).toEqual({
      readiness: 7,
      readinessBusy: 4,
      liveness: 2,
      startup: 1,
      restartsByLiveness: 1,
      lastFailureAt: '2026-10-09T17:00:00.000Z',
      read: true,
    });
  });

  it('leaves out other applications, older events and other reasons', () => {
    const f = countFailures(
      [
        ev(
          'flui-api-gateway-6fc4b5d7db-7wgmd',
          'Unhealthy',
          'Readiness probe failed',
          '2026-10-09T17:00:00Z',
        ),
        ev(
          'flui-api-6fc4b5d7db-7wgmd',
          'Unhealthy',
          'Readiness probe failed',
          '2026-10-09T15:00:00Z',
        ),
        ev(
          'flui-api-6fc4b5d7db-7wgmd',
          'Pulled',
          'Successfully pulled image',
          '2026-10-09T17:00:00Z',
        ),
      ],
      'flui-api',
      NOW,
    );
    expect(f.readiness + f.liveness + f.startup + f.restartsByLiveness).toBe(0);
    expect(f.lastFailureAt).toBeNull();
  });

  it('recognises the copies of a database, numbered rather than hashed', () => {
    const f = countFailures(
      [
        ev(
          'postgres-0',
          'Unhealthy',
          'Readiness probe failed: timeout',
          '2026-10-09T17:05:00Z',
        ),
      ],
      'postgres',
      NOW,
    );
    expect(f.readiness).toBe(1);
  });
});
