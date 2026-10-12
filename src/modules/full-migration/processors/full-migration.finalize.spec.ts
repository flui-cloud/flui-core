jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { FullMigrationProcessor } from './full-migration.processor';
import { AppMigrationStatus } from '../../app-migration/enums/app-migration.enum';
import {
  FullMigrationStatus,
  FullStagingMode,
} from '../enums/full-migration.enum';

function setup(
  appChild: any,
  legEnds: AppMigrationStatus = AppMigrationStatus.COMPLETED,
) {
  const calls: string[] = [];
  const fm: any = {
    id: 'fm-1',
    appId: 'app-1',
    dbMigrationId: 'dbm-1',
    appMigrationId: 'am-1',
    targetClusterId: 'dst',
    stagingMode: FullStagingMode.SCALED_DOWN,
  };
  const appMigRepo = {
    findOne: jest.fn(async () => appChild),
    save: jest.fn(async (e: any) => e),
  };
  const materializer = {
    materializeOnCluster: jest.fn(async (_a: any, c: string, o: any) => {
      calls.push(`materialize:${c}:${o?.replicas ?? 'full'}`);
    }),
  };
  const appMig = {
    cutover: jest.fn(async () => {
      calls.push('app-cutover');
      appChild.status = legEnds;
    }),
  };
  const ops = {
    setStep: jest.fn(async () => undefined),
    waitApp: jest.fn(async () => undefined),
    waitAppAny: jest.fn(async () => undefined),
    completeOperation: jest.fn(async () => undefined),
    fail: jest.fn(async () => undefined),
  };
  const proc = new FullMigrationProcessor(
    { save: jest.fn(async (e: any) => e) } as any,
    { findOne: jest.fn(async () => null) } as any,
    appMigRepo as any,
    { findById: jest.fn(async () => ({ id: 'app-1' })) } as any,
    {} as any,
    {} as any,
    appMig as any,
    materializer as any,
    { applyRewirePlan: jest.fn() } as any,
    ops as any,
  );
  return { proc, fm, calls, ops, materializer };
}

describe('FullMigrationProcessor finalizeAppLeg', () => {
  it('keeps the destination stopped when the app leg still has volumes to move', async () => {
    const { proc, fm, calls } = setup({
      id: 'am-1',
      status: AppMigrationStatus.READY,
      provisionOverrides: { volumeDestinationId: 'dest-1' },
    });
    await (proc as any).finalizer.finalizeAppLeg(fm);
    expect(calls).toEqual(['materialize:dst:0', 'app-cutover']);
  });

  it('starts the destination at full copies when there are no volumes', async () => {
    const { proc, fm, calls } = setup({
      id: 'am-1',
      status: AppMigrationStatus.READY,
      provisionOverrides: {},
    });
    await (proc as any).finalizer.finalizeAppLeg(fm);
    expect(calls).toEqual(['materialize:dst:full', 'app-cutover']);
  });

  it('does not stop a destination whose volumes already moved on a resumed run', async () => {
    const { proc, fm, calls } = setup({
      id: 'am-1',
      status: AppMigrationStatus.COMPLETED,
      provisionOverrides: { volumeDestinationId: 'dest-1' },
    });
    await (proc as any).finalizer.finalizeAppLeg(fm);
    expect(calls).toEqual(['materialize:dst:full']);
  });

  it('ends in BRIDGING, with the operation complete, when the app leg leaves a bridge open', async () => {
    const { proc, fm, ops } = setup(
      {
        id: 'am-1',
        status: AppMigrationStatus.READY,
        provisionOverrides: {},
      },
      AppMigrationStatus.BRIDGING,
    );
    await (proc as any).finalizer.finalizeAppLeg(fm);
    expect(fm.status).toBe(FullMigrationStatus.BRIDGING);
    expect(ops.completeOperation).toHaveBeenCalled();
    expect(fm.finishedAt).toBeUndefined();
  });

  it('does not stop a destination whose leg is already bridging on a resumed run', async () => {
    const { proc, fm, calls } = setup({
      id: 'am-1',
      status: AppMigrationStatus.BRIDGING,
      provisionOverrides: { volumeDestinationId: 'dest-1' },
    });
    await (proc as any).finalizer.finalizeAppLeg(fm);
    expect(calls).toEqual(['materialize:dst:full']);
    expect(fm.status).toBe(FullMigrationStatus.BRIDGING);
  });

  it('does not re-apply a live-fenced consumer that already runs the rewired env', async () => {
    const { proc, fm, calls, materializer } = setup({
      id: 'am-1',
      status: AppMigrationStatus.READY,
      provisionOverrides: {},
    });
    fm.stagingMode = FullStagingMode.LIVE_FENCED;
    (materializer as any).isCurrentOnCluster = jest.fn(async () => true);

    await (proc as any).finalizer.finalizeAppLeg(fm);

    expect((materializer as any).isCurrentOnCluster).toHaveBeenCalledWith(
      { id: 'app-1' },
      'dst',
    );
    expect(calls).toEqual(['app-cutover']);
  });
});

describe('FullMigrationProcessor promoteDbLeg', () => {
  it('polls the promote fast, since the write pause runs until it is seen', async () => {
    const { proc, ops } = setup({
      id: 'am-1',
      status: AppMigrationStatus.READY,
    });
    (ops as any).waitDb = jest.fn(async () => undefined);
    (proc as any).dbMig = { cutover: jest.fn(async () => undefined) };

    await (proc as any).promoteDbLeg(
      { id: 'fm-1', rewirePlan: { env: [] } },
      { id: 'dbm-1', status: 'synced' },
    );

    expect((ops as any).waitDb).toHaveBeenCalledWith(
      'dbm-1',
      'completed',
      expect.any(Number),
      1_000,
    );
  });
});
