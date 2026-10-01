jest.mock('@kubernetes/client-node', () => ({}));

import { needsDecision } from './cluster-decisions.service';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';

const support = {
  database: (e: string) => ['postgres', 'mariadb'].includes(e),
  consistentCopy: (e: string) => e === 'redis',
};

const app = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    name: id,
    slug: id,
    clusterId: 'c1',
    kind: 'APPLICATION',
    category: 'user',
    systemProtected: false,
    volumes: [{ name: 'data' }],
    labels: {},
    ...over,
  }) as any;

const copyPolicy = (appId: string, metadata: Record<string, unknown> = {}) =>
  ({
    id: `p-${appId}`,
    clusterId: 'c1',
    engineClass: BackupEngineClass.VOLUME_COPY,
    scopeSelector: { applicationIds: [appId] },
    enabled: true,
    metadata,
  }) as any;

const run = (volumes: Array<{ volume: string; reason: string }>) => ({
  metadata: { volumesNeedingDecision: volumes },
  finishedAt: new Date('2026-10-01T03:31:00Z'),
  createdAt: new Date('2026-10-01T03:30:00Z'),
});

describe('volumes that need a decision, per cluster', () => {
  it('names a database Flui does not recognise and nothing protects', () => {
    const items = needsDecision(
      [
        app('mongo', { labels: { 'flui.cloud/db-engine': 'mongodb' } }),
        app('pg', { labels: { 'flui.cloud/db-engine': 'postgres' } }),
        app('web'),
      ],
      [],
      new Map(),
      support,
    );
    expect(items).toEqual([
      expect.objectContaining({
        applicationId: 'mongo',
        engine: 'mongodb',
        source: 'engine',
        options: ['stop_during_copy', 'leave_out'],
      }),
    ]);
  });

  it('names each volume the last copy refused, until it is left out or copied at rest', () => {
    const refused = run([
      {
        volume: 'db',
        reason: 'holds a mysql data directory and is being written to',
      },
      {
        volume: 'cache',
        reason: 'holds a leveldb data directory and is being written to',
      },
    ]);
    const open = needsDecision(
      [app('shop')],
      [copyPolicy('shop', { excludeVolumes: ['cache'] })],
      new Map([['p-shop', refused]]),
      support,
    );
    expect(open).toEqual([
      expect.objectContaining({
        applicationId: 'shop',
        volume: 'db',
        source: 'last_run',
        policyId: 'p-shop',
        at: '2026-10-01T03:31:00.000Z',
      }),
    ]);

    const decided = needsDecision(
      [app('shop')],
      [copyPolicy('shop', { pauseDuringCopy: true })],
      new Map([['p-shop', refused]]),
      support,
    );
    expect(decided).toEqual([]);
  });

  it('does not ask again about an application whose policy now covers it', () => {
    expect(
      needsDecision(
        [app('mongo', { labels: { 'flui.cloud/db-engine': 'mongodb' } })],
        [copyPolicy('mongo', { pauseDuringCopy: true })],
        new Map(),
        support,
      ),
    ).toEqual([]);
  });
});
