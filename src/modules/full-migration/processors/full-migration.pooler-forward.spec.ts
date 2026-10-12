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

const pooler = (routed = true) => ({
  enabled: true,
  routed,
  upstream: { mode: 'local' },
});

function setup(
  opts: {
    srcPooler?: any;
    viaPooler?: boolean;
    forwardFails?: boolean;
    promoteFails?: { status: DbMigrationStatus; fence?: any };
    bridgeFails?: boolean;
    deadlineMs?: number | null;
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
    stagingMode: FullStagingMode.LIVE_FENCED,
    rewirePlan: { env: [], viaPooler: opts.viaPooler ?? true },
  };
  const dbChild: any = {
    id: 'dbm-1',
    dstAppId: 'db-b',
    linkId: 'link-1',
    kind: DbReplicationKind.PHYSICAL,
    status: DbMigrationStatus.SYNCED,
  };
  const leg: any = {
    id: 'am-1',
    status: AppMigrationStatus.READY,
    provisionOverrides: {},
    bridgeState: { mode: 'bridge', state: 'preparing', hosts: [] },
  };
  const dbMigRepo = {
    findOne: jest.fn(async () => dbChild),
    update: jest.fn(async (_id: string, p: any) => {
      Object.assign(dbChild, p);
      if ('poolerCut' in p)
        calls.push(p.poolerCut ? 'write-plan' : 'clear-plan');
    }),
  };
  const apps: Record<string, any> = {
    'db-a': {
      id: 'db-a',
      pooler: opts.srcPooler === undefined ? pooler() : opts.srcPooler,
    },
    'db-b': { id: 'db-b', pooler: pooler(false) },
  };
  const appMig = {
    openBridge: jest.fn(async () => calls.push('open-bridge')),
    rollbackBridge: jest.fn(async () => calls.push('rollback-bridge')),
    rollbackBridgeWhenIdle: jest.fn(async () =>
      calls.push('rollback-when-idle'),
    ),
    cutover: jest.fn(async () => {
      calls.push('app-cutover');
      leg.status = AppMigrationStatus.BRIDGING;
    }),
    abort: jest.fn(async () => undefined),
  };
  const ops = {
    load: jest.fn(async () => fm),
    setStep: jest.fn(async (_f: any, step: string) =>
      calls.push(`step:${step}`),
    ),
    setState: jest.fn(async (f: any, status: FullMigrationStatus) => {
      f.status = status;
      calls.push(`state:${status}`);
    }),
    pauseDeadlineMs: jest.fn(async () => opts.deadlineMs ?? null),
    waitAppBridge: jest.fn(async () => {
      if (opts.bridgeFails) throw new Error('bridge failed');
      leg.bridgeState.state = 'active';
      leg.status = AppMigrationStatus.CUTOVER;
      return 'active';
    }),
    waitDb: jest.fn(async () => {
      if (opts.promoteFails) {
        Object.assign(dbChild, opts.promoteFails);
        throw new Error('drain timed out');
      }
      dbChild.status = DbMigrationStatus.COMPLETED;
    }),
    waitAppAny: jest.fn(async () => undefined),
    completeOperation: jest.fn(async () => undefined),
    fail: jest.fn(async (f: any, _e: any, status: FullMigrationStatus) => {
      f.status = status;
    }),
  };
  const poolerCut = {
    forward: jest.fn(async () => {
      calls.push('forward');
      if (opts.forwardFails) throw new Error('probe saw the standby');
      return { systemIdentifier: '7301', timeline: 3 };
    }),
    unforward: jest.fn(async () => {
      calls.push('unforward');
      return [];
    }),
  };
  const proc = new FullMigrationProcessor(
    {
      update: jest.fn(async () => ({ affected: 1 })),
      findOne: jest.fn(async () => fm),
      save: jest.fn(async (e: any) => e),
    } as any,
    dbMigRepo as any,
    {
      findOne: jest.fn(async () => leg),
      save: jest.fn(async (e: any) => e),
    } as any,
    {
      findById: jest.fn(async (id: string) => apps[id] ?? { id, env: [] }),
    } as any,
    { cutover: jest.fn(async () => calls.push('fence+promote')) } as any,
    { unfence: jest.fn(async () => undefined) } as any,
    appMig as any,
    {
      isCurrentOnCluster: jest.fn(async () => true),
      materializeOnCluster: jest.fn(async () => undefined),
    } as any,
    { applyRewirePlan: jest.fn(async () => undefined) } as any,
    ops as any,
    poolerCut as any,
  );
  const run = () => proc.runCutover({ data: { migrationId: 'fm-1' } } as any);
  const flow = () => calls.filter((c) => !c.startsWith('step:'));
  return { run, flow, calls, fm, dbChild, poolerCut, appMig };
}

describe('full migration with a pooled database: the destination pooler forwards before the bridge', () => {
  it('forwards, writes the pause plan on the database leg, then opens the bridge and cuts over', async () => {
    const { run, flow, calls, dbChild, fm } = setup({ deadlineMs: 12_000 });
    await run();
    expect(flow()).toEqual([
      'forward',
      'write-plan',
      'open-bridge',
      'fence+promote',
      'app-cutover',
    ]);
    expect(calls).toContain(
      `step:${OperationStep.FULL_MIGRATE_POOLER_FORWARD}`,
    );
    expect(dbChild.poolerCut).toEqual({
      poolers: [
        { appId: 'db-a', role: 'source' },
        { appId: 'db-b', role: 'destination' },
      ],
      deadlineMs: 12_000,
      sourceSystemIdentifier: '7301',
      sourceTimeline: 3,
    });
    expect(fm.status).toBe(FullMigrationStatus.BRIDGING);
  });

  it('clears the error a failed earlier attempt left once a retry is claimed', async () => {
    const { run, fm } = setup();
    fm.errorMessage = 'The destination pooler could not forward to the source';
    await run();
    expect(fm.errorMessage).toBeUndefined();
  });

  it('defaults the pause deadline to five seconds', async () => {
    const { run, dbChild } = setup();
    await run();
    expect(dbChild.poolerCut.deadlineMs).toBe(5000);
  });

  it('undoes a forward that cannot be set up, opens no bridge, and is READY to retry', async () => {
    const { run, flow, fm } = setup({ forwardFails: true });
    await run();
    expect(flow()).toEqual([
      'forward',
      'unforward',
      'clear-plan',
      `state:${FullMigrationStatus.READY}`,
    ]);
    expect(fm.errorMessage).toMatch(/could not forward.*probe saw the standby/);
  });

  it('rolls the bridge back, then stops forwarding, when the bridge cannot open', async () => {
    const { run, flow, fm } = setup({ bridgeFails: true });
    await expect(run()).rejects.toThrow(/bridge failed/);
    expect(flow()).toEqual([
      'forward',
      'write-plan',
      'open-bridge',
      'rollback-when-idle',
      'unforward',
    ]);
    expect(fm.status).toBe(FullMigrationStatus.FAILED);
  });

  it('rolls the bridge back, then stops forwarding, when the database leg returns to SYNCED', async () => {
    const { run, flow } = setup({
      promoteFails: { status: DbMigrationStatus.SYNCED },
    });
    await expect(run()).rejects.toThrow(/drain/);
    expect(flow()).toEqual([
      'forward',
      'write-plan',
      'open-bridge',
      'fence+promote',
      'rollback-bridge',
      'unforward',
    ]);
  });

  it('keeps forwarding once the promote was asked', async () => {
    const { run, poolerCut, fm } = setup({
      promoteFails: {
        status: DbMigrationStatus.CUTOVER,
        fence: { promoteIssuedAt: '2026-10-12T10:00:00Z' },
      },
    });
    await expect(run()).rejects.toThrow();
    expect(poolerCut.unforward).not.toHaveBeenCalled();
    expect(fm.status).toBe(FullMigrationStatus.FAILED_FORWARD);
  });

  it('behaves as today without a pooler on the source', async () => {
    const { run, flow, poolerCut } = setup({ srcPooler: null });
    await run();
    expect(poolerCut.forward).not.toHaveBeenCalled();
    expect(flow()).toEqual(['open-bridge', 'fence+promote', 'app-cutover']);
  });

  it('does not forward when the app reaches the database directly', async () => {
    const { run, poolerCut } = setup({ viaPooler: false });
    await run();
    expect(poolerCut.forward).not.toHaveBeenCalled();
  });
});
