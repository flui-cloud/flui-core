jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { FullMigrationProcessor } from './full-migration.processor';
import { DbMigrationStatus } from '../../db-lifecycle/enums/db-migration.enum';
import { DbReplicationKind } from '../../db-lifecycle/enums/db-replication-status.enum';
import { AppMigrationStatus } from '../../app-migration/enums/app-migration.enum';
import { OperationStep } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  FullMigrationStatus,
  FullStagingMode,
} from '../enums/full-migration.enum';

function setup(
  opts: {
    staging?: FullStagingMode;
    kind?: DbReplicationKind;
    dbStatus?: DbMigrationStatus;
    legState?: string;
    legStatus?: AppMigrationStatus;
    legMode?: string;
    promoteFails?: { status: DbMigrationStatus; fence?: any };
    bridgeOutcome?: 'active' | 'dns-only' | 'fails';
  } = {},
) {
  const calls: string[] = [];
  const fm: any = {
    id: 'fm-1',
    appId: 'app-1',
    dbAppId: 'db-a',
    dbMigrationId: 'dbm-1',
    appMigrationId: 'am-1',
    targetClusterId: 'B',
    status: FullMigrationStatus.READY,
    stagingMode: opts.staging ?? FullStagingMode.LIVE_FENCED,
    rewirePlan: { env: [] },
  };
  const dbChild: any = {
    id: 'dbm-1',
    dstAppId: 'db-b',
    kind: opts.kind ?? DbReplicationKind.PHYSICAL,
    status: opts.dbStatus ?? DbMigrationStatus.SYNCED,
  };
  const leg: any = {
    id: 'am-1',
    status: opts.legStatus ?? AppMigrationStatus.READY,
    provisionOverrides: {},
    bridgeState: {
      mode: opts.legMode ?? 'bridge',
      skipReason: null,
      state: opts.legState ?? 'preparing',
      hosts: [],
    },
  };
  const fmRepo = {
    update: jest.fn(async () => ({ affected: 1 })),
    findOne: jest.fn(async () => fm),
    save: jest.fn(async (e: any) => e),
  };
  const appMig = {
    openBridge: jest.fn(async () => {
      calls.push('open-bridge');
    }),
    rollbackBridge: jest.fn(async () => {
      calls.push('rollback-bridge');
    }),
    rollbackBridgeWhenIdle: jest.fn(async () => {
      calls.push('rollback-when-idle');
    }),
    cutover: jest.fn(async () => {
      calls.push('app-cutover');
      leg.status = AppMigrationStatus.BRIDGING;
    }),
    abort: jest.fn(async () => undefined),
  };
  const ops = {
    load: jest.fn(async () => fm),
    setStep: jest.fn(async (_f: any, step: string) => {
      calls.push(`step:${step}`);
    }),
    waitAppBridge: jest.fn(async () => {
      if (opts.bridgeOutcome === 'fails') throw new Error('bridge failed');
      calls.push('bridge-seen');
      if (opts.bridgeOutcome === 'dns-only') {
        leg.bridgeState.mode = 'dns-only';
        return 'dns-only';
      }
      leg.bridgeState.state = 'active';
      leg.status = AppMigrationStatus.CUTOVER;
      return 'active';
    }),
    waitDb: jest.fn(async () => {
      if (opts.promoteFails) {
        Object.assign(dbChild, opts.promoteFails);
        throw new Error('drain timed out');
      }
      calls.push('promoted');
      dbChild.status = DbMigrationStatus.COMPLETED;
    }),
    waitAppAny: jest.fn(async () => undefined),
    completeOperation: jest.fn(async () => undefined),
    fail: jest.fn(async (f: any, _e: any, status: FullMigrationStatus) => {
      f.status = status;
    }),
  };
  const dbMig = {
    cutover: jest.fn(async () => {
      calls.push('fence+promote');
    }),
  };
  const legRepo = {
    findOne: jest.fn(async () => leg),
    save: jest.fn(async (e: any) => e),
  };
  const proc = new FullMigrationProcessor(
    fmRepo as any,
    { findOne: jest.fn(async () => dbChild) } as any,
    legRepo as any,
    { findById: jest.fn(async (id: string) => ({ id, env: [] })) } as any,
    dbMig as any,
    { unfence: jest.fn(async () => undefined) } as any,
    appMig as any,
    {
      isCurrentOnCluster: jest.fn(async () => true),
      materializeOnCluster: jest.fn(async () => undefined),
    } as any,
    {
      applyRewirePlan: jest.fn(async () => {
        calls.push('rewire-app-row');
      }),
    } as any,
    ops as any,
  );
  const run = () => proc.runCutover({ data: { migrationId: 'fm-1' } } as any);
  return {
    proc,
    fm,
    calls,
    appMig,
    ops,
    dbChild,
    leg,
    run,
    legRepo,
  };
}

describe('full migration, live-fenced and physical: the bridge opens before the fence', () => {
  it('opens the bridge and waits for it before fencing and promoting, then finishes the app leg', async () => {
    const { run, calls, fm, appMig } = setup();

    await run();

    expect(calls.filter((c) => !c.startsWith('step:'))).toEqual([
      'open-bridge',
      'bridge-seen',
      'fence+promote',
      'promoted',
      'app-cutover',
      'rewire-app-row',
    ]);
    expect(calls).toContain(`step:${OperationStep.FULL_MIGRATE_BRIDGE_OPEN}`);
    expect(appMig.openBridge).toHaveBeenCalledWith('am-1', true);
    expect(fm.status).toBe(FullMigrationStatus.BRIDGING);
  });

  it('rolls the bridge back when the promote fails before it was asked', async () => {
    const { run, calls, fm, appMig } = setup({
      promoteFails: { status: DbMigrationStatus.SYNCED },
    });

    await expect(run()).rejects.toThrow(/drain/);

    expect(calls.filter((c) => !c.startsWith('step:'))).toEqual([
      'open-bridge',
      'bridge-seen',
      'fence+promote',
      'rollback-bridge',
    ]);
    expect(appMig.rollbackBridge).toHaveBeenCalledWith('am-1', true);
    expect(fm.status).toBe(FullMigrationStatus.FAILED);
  });

  it('keeps the bridge and goes forward once the promote was asked', async () => {
    const { run, fm, appMig } = setup({
      promoteFails: {
        status: DbMigrationStatus.CUTOVER,
        fence: { promoteIssuedAt: '2026-10-11T22:00:00Z' },
      },
    });

    await expect(run()).rejects.toThrow();

    expect(appMig.rollbackBridge).not.toHaveBeenCalled();
    expect(fm.status).toBe(FullMigrationStatus.FAILED_FORWARD);
  });

  it('fails before the fence, with nothing to roll back, when the bridge cannot open', async () => {
    const { run, calls, fm } = setup({ bridgeOutcome: 'fails' });

    await expect(run()).rejects.toThrow(/bridge failed/);

    expect(calls).not.toContain('fence+promote');
    expect(fm.status).toBe(FullMigrationStatus.FAILED);
  });

  it('goes on in the old order when the bridge falls back to DNS only', async () => {
    const { run, calls } = setup({ bridgeOutcome: 'dns-only' });

    await run();

    expect(calls.filter((c) => !c.startsWith('step:'))).toEqual([
      'open-bridge',
      'bridge-seen',
      'fence+promote',
      'promoted',
      'app-cutover',
      'rewire-app-row',
    ]);
  });

  it('does not open the bridge again when a resumed cutover finds it open', async () => {
    const { run, appMig, calls } = setup({
      legState: 'active',
      legStatus: AppMigrationStatus.CUTOVER,
    });

    await run();

    expect(appMig.openBridge).not.toHaveBeenCalled();
    expect(calls).toContain('fence+promote');
  });

  it('only finishes the app leg from the open bridge after a promote that already happened', async () => {
    const { run, appMig, calls, fm } = setup({
      dbStatus: DbMigrationStatus.COMPLETED,
      legState: 'active',
      legStatus: AppMigrationStatus.CUTOVER,
    });
    fm.status = FullMigrationStatus.FAILED_FORWARD;

    await run();

    expect(appMig.openBridge).not.toHaveBeenCalled();
    expect(calls).not.toContain('fence+promote');
    expect(calls).toContain('app-cutover');
    expect(fm.status).toBe(FullMigrationStatus.BRIDGING);
  });

  it.each([
    ['scaled-down staging', { staging: FullStagingMode.SCALED_DOWN }],
    ['a logical db leg', { kind: DbReplicationKind.LOGICAL }],
    ['a DNS-only app leg', { legMode: 'dns-only' }],
  ])('keeps the old order with %s', async (_label, over) => {
    const { run, appMig, calls } = setup(over as any);

    await run();

    expect(appMig.openBridge).not.toHaveBeenCalled();
    expect(calls.filter((c) => !c.startsWith('step:'))[0]).toBe(
      'fence+promote',
    );
  });
});

describe('bridge-before-fence fixes after review (orchestrator)', () => {
  it('opens the bridge again for a leg a crash left in CUTOVER before it was active', async () => {
    const { run, appMig, calls, fm } = setup({
      legStatus: AppMigrationStatus.CUTOVER,
      legState: 'preparing',
    });

    await run();

    expect(appMig.openBridge).toHaveBeenCalledWith('am-1', true);
    expect(calls.filter((c) => !c.startsWith('step:'))).toEqual([
      'open-bridge',
      'bridge-seen',
      'fence+promote',
      'promoted',
      'app-cutover',
      'rewire-app-row',
    ]);
    expect(appMig.cutover).toHaveBeenCalled();
    expect(fm.status).toBe(FullMigrationStatus.BRIDGING);
  });

  it('drives a DNS-only leg a crash left in CUTOVER after the promote', async () => {
    const { run, appMig, fm } = setup({
      dbStatus: DbMigrationStatus.COMPLETED,
      legMode: 'dns-only',
      legStatus: AppMigrationStatus.CUTOVER,
    });
    fm.status = FullMigrationStatus.FAILED_FORWARD;

    await run();

    expect(appMig.cutover).toHaveBeenCalledWith('am-1', true);
  });

  it('rolls back a bridge that failed to open once its leg is idle', async () => {
    const { run, calls } = setup({ bridgeOutcome: 'fails' });

    await expect(run()).rejects.toThrow(/bridge failed/);

    expect(calls).toContain('rollback-when-idle');
    expect(calls).not.toContain('fence+promote');
  });

  it('leaves the bridge up while the db leg still holds the fence without having asked the promote', async () => {
    const { run, appMig, fm } = setup({
      promoteFails: { status: DbMigrationStatus.CUTOVER, fence: {} },
    });

    await expect(run()).rejects.toThrow();

    expect(appMig.rollbackBridge).not.toHaveBeenCalled();
    expect(fm.status).toBe(FullMigrationStatus.FAILED);
  });

  it('hands the rewired env to the app leg and writes it to the app only after the leg moved it', async () => {
    const { run, calls, fm, legRepo, leg } = setup();
    fm.rewirePlan = { env: [{ name: 'DATABASE_URL', value: 'b' }] };

    await run();

    expect(leg.provisionOverrides.env).toEqual([
      { name: 'DATABASE_URL', value: 'b' },
    ]);
    expect(legRepo.save).toHaveBeenCalled();
    expect(calls.indexOf('rewire-app-row')).toBeGreaterThan(
      calls.indexOf('app-cutover'),
    );
  });
});
