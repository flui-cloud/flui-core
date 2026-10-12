jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { DbMigrationViewService } from './db-migration-view.service';
import { DbMigrationStatus } from '../enums/db-migration.enum';
import {
  DbReplicationKind,
  DbReplicationStatus,
} from '../enums/db-replication-status.enum';

describe('DbMigrationViewService', () => {
  const physical = {
    id: 'm1',
    kind: DbReplicationKind.PHYSICAL,
    status: DbMigrationStatus.REPLICATING,
    linkId: 'l1',
    fence: null,
  };
  const logical = {
    id: 'm2',
    kind: DbReplicationKind.LOGICAL,
    status: DbMigrationStatus.COMPLETED,
    dstAppId: 'dst-2',
    linkId: 'l2',
  };
  const repo = (rows: any[]) => ({
    find: jest.fn(async ({ where }: any) =>
      rows.filter((r) => where.id._value.includes(r.id)),
    ),
  });
  const replRepo = repo([
    { id: 'l1', wgLinkId: 'wg1', status: DbReplicationStatus.COPYING },
    { id: 'l2', wgLinkId: null, status: DbReplicationStatus.PROMOTED },
  ]);
  const wgRepo = repo([
    {
      id: 'wg1',
      state: 'open',
      listenerNodeId: 'n-a',
      dialerNodeId: 'n-b',
      lastHandshakeAt: null,
    },
  ]);
  const nodeRepo = repo([
    { id: 'n-a', serverName: 'hz-worker-1' },
    { id: 'n-b', serverName: 'scw-master' },
  ]);
  const svc = new DbMigrationViewService(
    {
      list: jest.fn(async () => [physical, logical]),
      findById: jest.fn(async () => physical),
    } as any,
    replRepo as any,
    wgRepo as any,
    nodeRepo as any,
  );

  it('answers each row with its own link, copy phase and next steps', async () => {
    const [p, l] = await svc.listViews('u1');

    expect(p.link).toEqual(
      expect.objectContaining({
        listenerNode: 'hz-worker-1',
        dialerNode: 'scw-master',
        handshakeSeen: false,
      }),
    );
    expect(p.baseBackup).toEqual({ phase: 'copying', lagBytes: null });
    expect(p.nextSteps).toEqual([]);
    expect(l.link).toBeNull();
    expect(l.baseBackup).toBeNull();
    expect(l.nextSteps.map((s) => s.key)).toEqual([
      'protect-database',
      'repoint-consumers',
    ]);
  });

  it('reads the links in one query per table, not per row', async () => {
    replRepo.find.mockClear();
    wgRepo.find.mockClear();
    await svc.listViews('u1');
    expect(replRepo.find).toHaveBeenCalledTimes(1);
    expect(wgRepo.find).toHaveBeenCalledTimes(1);
  });

  it('serves one migration the same way', async () => {
    const view = await svc.getView('m1');
    expect(view.kind).toBe('physical');
    expect(view.link?.state).toBe('open');
  });
});
