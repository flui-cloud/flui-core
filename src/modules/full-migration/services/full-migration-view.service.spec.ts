jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { FullMigrationViewService } from './full-migration-view.service';
import { FullMigrationStatus } from '../enums/full-migration.enum';

describe('FullMigrationViewService', () => {
  const base = {
    id: 'fm1',
    status: FullMigrationStatus.COMPLETED,
    dbMigrationId: 'dbm1',
    appMigrationId: 'am1',
    writePauseMs: 6500,
    writePauseEndedBy: 'bridge',
    bridge: null,
  };
  const dbLeg = { id: 'dbm1', dstAppId: 'db-new' };
  const dbViews = {
    views: jest.fn(async (rows: any[]) =>
      rows.map((r) => ({
        ...r,
        kind: 'physical',
        link: { state: 'closed', handshakeSeen: true },
        fence: { appliedAt: '2026-10-11T10:00:00.000Z', released: false },
        baseBackup: { phase: 'done', lagBytes: null },
      })),
    ),
  };
  const svc = new FullMigrationViewService(
    {
      getView: jest.fn(async () => base),
      listViews: jest.fn(async () => [base]),
    } as any,
    dbViews as any,
    { find: jest.fn(async () => [dbLeg]) } as any,
    {
      find: jest.fn(async () => [
        { id: 'am1', interruptionMs: 4000, sourceDestroyedAt: null },
      ]),
    } as any,
  );

  it('adds the database leg, the measures and the next steps to the bridge view', async () => {
    const view = await svc.getView('fm1');
    expect(view).toEqual(
      expect.objectContaining({
        kind: 'physical',
        link: { state: 'closed', handshakeSeen: true },
        writePauseMs: 6500,
        writePauseEndedBy: 'bridge',
        interruptionMs: 4000,
      }),
    );
    expect(view.nextSteps.map((s) => s.key)).toEqual([
      'protect-database',
      'destroy-source',
    ]);
    expect(view.nextSteps[0].text).toContain('db-new');
  });

  it('lists the same view', async () => {
    const [row] = await svc.listViews('u1');
    expect(row.kind).toBe('physical');
    expect(row.interruptionMs).toBe(4000);
  });
});
