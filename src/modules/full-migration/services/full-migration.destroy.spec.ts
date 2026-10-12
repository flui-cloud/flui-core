jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { FullMigrationService } from './full-migration.service';
import { FullMigrationStatus } from '../enums/full-migration.enum';
import { AppMigrationStatus } from '../../app-migration/enums/app-migration.enum';

function setup(status: FullMigrationStatus) {
  const fm: any = { id: 'fm-1', status, appMigrationId: 'am-1' };
  const leg: any = {
    id: 'am-1',
    status: AppMigrationStatus.BRIDGING,
    bridgeState: {
      mode: 'bridge',
      skipReason: null,
      state: 'active',
      hosts: [],
      dnsFlippedAt: '2026-10-11T11:55:00.000Z',
      recordTtlSeconds: 300,
    },
  };
  const fmRepo = {
    findOne: jest.fn(async () => fm),
    save: jest.fn(async (e: any) => e),
    find: jest.fn(async () => [fm]),
    update: jest.fn(async () => ({ affected: 1 })),
  };
  const appMigRepo = {
    findOne: jest.fn(async () => leg),
    find: jest.fn(async () => [leg]),
  };
  const calls: string[] = [];
  const appMig = {
    rollbackBridge: jest.fn(async () => {
      calls.push('rollback-bridge');
    }),
    abort: jest.fn(async () => {
      calls.push('leg-abort');
    }),
    destroySource: jest.fn(async () => {
      leg.status = AppMigrationStatus.COMPLETED;
      return leg;
    }),
  };
  const svc = new FullMigrationService(
    fmRepo as any,
    {} as any,
    {} as any,
    {} as any,
    appMigRepo as any,
    {} as any,
    {} as any,
    {} as any,
    appMig as any,
    {} as any,
    {} as any,
    {} as any,
  );
  return { svc, fm, appMig, calls };
}

describe('FullMigrationService and the bridge of its app leg', () => {
  it('destroys the source while bridging, passing the close decision to the app leg', async () => {
    const { svc, fm, appMig } = setup(FullMigrationStatus.BRIDGING);

    await svc.destroySource('fm-1', { closeBridge: true });

    expect(appMig.destroySource).toHaveBeenCalledWith('am-1', {
      closeBridge: true,
    });
    expect(fm.status).toBe(FullMigrationStatus.COMPLETED);
    expect(fm.finishedAt).toBeInstanceOf(Date);
  });

  it('shows the bridge of its app leg', async () => {
    const { svc } = setup(FullMigrationStatus.BRIDGING);

    const view: any = await svc.getView('fm-1');

    expect(view.bridge).toEqual(
      expect.objectContaining({ mode: 'bridge', state: 'active' }),
    );
    expect((await svc.listViews('user-1'))[0]).toEqual(
      expect.objectContaining({
        bridge: expect.objectContaining({ state: 'active' }),
      }),
    );
  });
});

describe('aborting a failed full migration whose bridge is open', () => {
  it('rolls the bridge back before tearing the app leg down', async () => {
    const { svc, calls, appMig } = setup(FullMigrationStatus.FAILED);

    await svc.abort('fm-1');

    expect(calls).toEqual(['rollback-bridge', 'leg-abort']);
    expect(appMig.rollbackBridge).toHaveBeenCalledWith('am-1', true);
  });
});
