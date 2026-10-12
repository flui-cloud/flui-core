import { DbPoolerStatus, poolerLines } from './db-pooler-view';

const base: DbPoolerStatus = {
  enabled: true,
  mode: 'transaction',
  replicas: 1,
  image: 'ghcr.io/cloudnative-pg/pgbouncer:1.26.0',
  upstream: 'local',
  routed: true,
  reason: null,
  addresses: {
    pooled: 'pg-pooler.ns.svc.cluster.local:5432',
    direct: 'pg-svc.ns.svc.cluster.local:5432',
  },
  pods: [{ name: 'pg-pooler-1', ready: true }],
};

describe('poolerLines', () => {
  it('names both addresses once the pooler carries the connection URL', () => {
    const lines = poolerLines(base);
    expect(lines[0]).toBe('pooler   transaction mode, 1/1 ready');
    expect(lines).toContain(
      'pooled   pg-pooler.ns.svc.cluster.local:5432   (FLUI_CONNECTION_URL)',
    );
    expect(lines.some((l) => l.startsWith('direct   pg-svc'))).toBe(true);
  });

  it('says why apps still connect directly', () => {
    const lines = poolerLines({
      ...base,
      routed: false,
      reason: 'The pooler did not become ready: timed out',
    });
    expect(lines).toContain('The pooler did not become ready: timed out');
    expect(lines.some((l) => l.startsWith('pooled'))).toBe(false);
  });

  it('says plainly when there is no pooler', () => {
    expect(
      poolerLines({
        ...base,
        enabled: false,
        addresses: { pooled: null, direct: 'pg-svc:5432' },
      })[0],
    ).toBe('No connection pooler: apps connect to the database directly.');
  });
});
