jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { DbMigrationProcessor } from './db-migration.processor';
import {
  DbCutoverMode,
  DbMigrationMode,
  DbMigrationStatus,
} from '../enums/db-migration.enum';
import { DbReplicationKind } from '../enums/db-replication-status.enum';
import { CatalogInstallStatus } from '../../catalog/enums/catalog-install-status.enum';
import {
  PromoteUnconfirmedError,
  SlotLostError,
} from '../services/db-physical-replication.service';

function matches(row: any, where: any): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object' && '_type' in v) {
      if (v._type === 'in') return v._value.includes(row[k]);
      if (v._type === 'raw') return !row[k]?.promoteIssuedAt;
    }
    return row[k] === v;
  });
}

function setup(over: Record<string, any> = {}) {
  const calls: string[] = [];
  const row: any = {
    id: 'm1',
    userId: 'u1',
    srcAppId: 'src',
    targetClusterId: 'dst-cluster',
    displayName: 'db-migrated',
    mode: DbMigrationMode.LIVE,
    kind: DbReplicationKind.PHYSICAL,
    cutoverMode: DbCutoverMode.AUTO,
    status: DbMigrationStatus.PENDING,
    ...over.mig,
  };
  const migRepo = {
    findOne: jest.fn(async () => ({ ...row })),
    save: jest.fn(async (m: any) => {
      Object.assign(row, m);
      return m;
    }),
    update: jest.fn(async (criteria: any, partial: any) => {
      if (typeof criteria === 'string') {
        Object.assign(row, partial);
        return { affected: 1 };
      }
      const list = Array.isArray(criteria) ? criteria : [criteria];
      if (!list.some((c) => matches(row, c))) return { affected: 0 };
      Object.assign(row, partial);
      return { affected: 1 };
    }),
  };
  const link: any = {
    id: '0123456789ab-0000',
    srcAppId: 'src',
    dstAppId: 'dst',
    srcNodeId: 'node-a',
    dstNodeId: 'node-b',
    ...over.link,
  };
  const install: any = {
    id: 'inst-1',
    status: CatalogInstallStatus.INSTALLING,
    applicationIds: ['dst'],
    ...over.install,
  };
  const physical = {
    getLink: jest.fn(async () => link),
    createLink: jest.fn(async () => link),
    openTransport: jest.fn(async () => calls.push('open-transport')),
    checkCompatibility: jest.fn(async () => []),
    assertRoomOnDestination: jest.fn(async () => undefined),
    attachStandby: jest.fn(async () => calls.push('attach')),
    standbyState: jest.fn(async () => ({ done: true, inRecovery: true })),
    status: jest.fn(async () => ({ state: 'streaming' })),
    verifyCopy: jest.fn(async () => calls.push('verify-copy')),
    markStreaming: jest.fn(async () => undefined),
    markPromoted: jest.fn(async () => undefined),
    recoveryState: jest.fn(async () => 'standby'),
    currentLsn: jest.fn(async () => '0/5A000110'),
    waitForReplay: jest.fn(async () => calls.push('replay')),
    promote: jest.fn(async () => calls.push('promote')),
    finishOnDestination: jest.fn(async () => calls.push('finish-dst')),
    finishOnSource: jest.fn(async () => calls.push('finish-src')),
    abort: jest.fn(async () => {
      calls.push('link-abort');
      return { notes: [] };
    }),
    ...over.physical,
  };
  const fence = {
    fence: jest.fn(async (_t: any, marker: string, persist: any) => {
      calls.push('fence');
      const record = {
        method: 'pg_hba',
        marker,
        hbaSha256Before: 'h0',
        appliedAt: 'now',
        releasedAt: null,
      };
      await persist(record);
      return record;
    }),
    unfence: jest.fn(async (_t: any, record: any) => {
      calls.push('unfence');
      return { ...record, releasedAt: 'later' };
    }),
  };
  const placement = {
    nodeOfApp: jest.fn(async (appId: string) => ({
      appId,
      clusterId: appId === 'src' ? 'src-cluster' : 'dst-cluster',
      nodeId: appId === 'src' ? 'node-a' : 'node-b',
      overlayIp: appId === 'src' ? '10.250.0.2' : '10.250.0.3',
    })),
    scheduled: jest.fn(async (appId: string) => ({
      appId,
      clusterId: 'dst-cluster',
      nodeId: 'node-b',
      overlayIp: '10.250.0.3',
    })),
  };
  const installer = {
    install: jest.fn(async () => ({ install: { id: 'inst-1' } })),
  };
  const installRepo = {
    findOne: jest.fn(async () => install),
    update: jest.fn(async (_id: string, p: any) => Object.assign(install, p)),
  };
  const handoff = {
    adoptSourceCredentials: jest.fn(async () => calls.push('credentials')),
    adoptSourcePoolerAuth: jest.fn(async () => {
      calls.push('adopt-pooler-auth');
      return true;
    }),
    adoptSourceIdentity: jest.fn(async () => calls.push('adopt-identity')),
  };
  const queue = { add: jest.fn(async () => undefined) };
  const nodeRepo = { count: jest.fn(async () => over.workers ?? 0) };
  const appRepo = {
    findOne: jest.fn(async () => ({
      id: 'src',
      resources: {
        cpu: { request: '500m', limit: '2' },
        memory: { request: '1Gi', limit: '2Gi' },
      },
      ...over.srcApp,
    })),
  };
  const poolerCut = over.poolerCut
    ? {
        pause: jest.fn(async (m: any) => {
          calls.push('pause');
          m.poolerCut = {
            ...m.poolerCut,
            pausedPods: [
              { appId: 'src', pod: 'src-pooler-1' },
              { appId: 'dst', pod: 'dst-pooler-1' },
            ],
            pausedAt: '2026-10-12T10:00:00.000Z',
          };
          row.poolerCut = m.poolerCut;
          return m.poolerCut;
        }),
        settleAfterFence: jest.fn(async () => calls.push('settle')),
        retargetAndResume: jest.fn(async (m: any) => {
          calls.push('retarget+resume-dst');
          m.poolerCut = {
            ...m.poolerCut,
            resumedAt: '2026-10-12T10:00:08.500Z',
          };
          row.poolerCut = m.poolerCut;
          return m.poolerCut;
        }),
        resumeRoles: jest.fn(async (_m: any, roles: string[], by: string) => {
          calls.push(`resume:${roles.join('+')}:${by}`);
          return [];
        }),
        suspendSource: jest.fn(async () => calls.push('suspend-src')),
        ...over.poolerCut,
      }
    : undefined;
  const poolers = over.poolers
    ? {
        applyObjects: jest.fn(async () => calls.push('apply-pooler')),
        bringUp: jest.fn(async () => {
          calls.push('bring-up-dst');
          return { routed: true, reason: null };
        }),
        ...over.poolers,
      }
    : undefined;
  const exec = {
    resolve: jest.fn(async (id: string) => ({
      appId: id,
      pgUser: 'app_user',
      pgDb: 'app_db',
    })),
  };
  const proc = new DbMigrationProcessor(
    migRepo as any,
    { update: jest.fn() } as any,
    installRepo as any,
    { findOne: jest.fn(async () => ({ email: 'a@b.c' })) } as any,
    installer as any,
    {} as any,
    {} as any,
    {} as any,
    physical as any,
    fence as any,
    placement as any,
    exec as any,
    handoff as any,
    appRepo as any,
    nodeRepo as any,
    queue as any,
    poolerCut as any,
    poolers as any,
  );
  (proc as any).sleep = jest.fn(async () => undefined);
  return {
    proc,
    row,
    calls,
    physical,
    fence,
    installer,
    installRepo,
    queue,
    handoff,
    placement,
    poolerCut,
    poolers,
  };
}

const job = { data: { migrationId: 'm1' } } as any;

describe('DbMigrationProcessor, physical path', () => {
  it('installs the destination as a standby with the source identity, on the master when there is no worker', async () => {
    const { proc, installer } = setup({
      mig: { cutoverMode: DbCutoverMode.MANUAL },
    });
    await proc.run(job);
    expect(installer.install).toHaveBeenCalledWith(
      'postgresql',
      expect.objectContaining({
        clusterId: 'dst-cluster',
        envOverrides: {
          POSTGRES_USER: 'app_user',
          POSTGRES_DB: 'app_db',
          FLUI_PG_STANDBY: '1',
        },
        allowMasterPlacement: true,
        resourceOverrides: {
          cpu: { request: '500m', limit: '2' },
          memory: { request: '1Gi', limit: '2Gi' },
        },
      }),
      'u1',
      'a@b.c',
    );
  });

  it('installs the standby without a pooler when the source has none', async () => {
    const { proc, installer, calls } = setup({
      mig: { cutoverMode: DbCutoverMode.MANUAL },
    });
    await proc.run(job);
    expect(installer.install).toHaveBeenCalledWith(
      'postgresql',
      expect.objectContaining({
        options: { pooler: false, poolerSessionMode: false },
      }),
      'u1',
      'a@b.c',
    );
    expect(calls).not.toContain('adopt-pooler-auth');
    expect(calls).not.toContain('adopt-identity');
  });

  it('mirrors the source pooler on the standby, and adopts its pooler password and identity before the standby starts', async () => {
    const { proc, installer, calls, handoff } = setup({
      mig: { cutoverMode: DbCutoverMode.MANUAL },
      srcApp: {
        pooler: { enabled: true, mode: 'session', routed: true },
      },
      poolers: {},
      physical: {
        standbyState: jest
          .fn()
          .mockResolvedValueOnce({ done: false, inRecovery: null })
          .mockResolvedValue({ done: true, inRecovery: true }),
      },
    });
    await proc.run(job);
    expect(installer.install).toHaveBeenCalledWith(
      'postgresql',
      expect.objectContaining({
        options: { pooler: true, poolerSessionMode: true },
      }),
      'u1',
      'a@b.c',
    );
    expect(calls).toEqual([
      'adopt-pooler-auth',
      'apply-pooler',
      'adopt-identity',
      'open-transport',
      'attach',
      'verify-copy',
    ]);
    expect(handoff.adoptSourceCredentials).not.toHaveBeenCalled();
  });

  it('keeps the destination off the master when the cluster has a worker', async () => {
    const { proc, installer } = setup({
      workers: 1,
      mig: { cutoverMode: DbCutoverMode.MANUAL },
    });
    await proc.run(job);
    expect(installer.install).toHaveBeenCalledWith(
      'postgresql',
      expect.objectContaining({ allowMasterPlacement: false }),
      'u1',
      'a@b.c',
    );
  });

  it('builds the link, copies, checks the copy and parks in SYNCED on a manual cutover', async () => {
    const { proc, row, calls, physical } = setup({
      mig: { cutoverMode: DbCutoverMode.MANUAL },
      physical: {
        standbyState: jest
          .fn()
          .mockResolvedValueOnce({ done: false, inRecovery: null })
          .mockResolvedValueOnce({ done: false, inRecovery: null })
          .mockResolvedValue({ done: true, inRecovery: true }),
      },
    });
    await proc.run(job);
    expect(calls).toEqual(['open-transport', 'attach', 'verify-copy']);
    expect(physical.markStreaming).toHaveBeenCalled();
    expect(row.status).toBe(DbMigrationStatus.SYNCED);
    expect(row.dstAppId).toBe('dst');
    expect(row.linkId).toBe(link().id);
  });

  it('tolerates the catalog install timing out while the base backup runs, and repairs it', async () => {
    const { proc, row, installRepo } = setup({
      mig: { cutoverMode: DbCutoverMode.MANUAL },
      install: {
        status: CatalogInstallStatus.FAILED,
        errorMessage:
          'Deploy failed for application dst: Timeout waiting for StatefulSet/x to be ready after 600000ms',
      },
      physical: {
        standbyState: jest
          .fn()
          .mockResolvedValueOnce({ done: false, inRecovery: null })
          .mockResolvedValueOnce({ done: false, inRecovery: null })
          .mockResolvedValue({ done: true, inRecovery: true }),
      },
    });
    await proc.run(job);
    expect(row.status).toBe(DbMigrationStatus.SYNCED);
    expect(installRepo.update).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({ status: CatalogInstallStatus.RUNNING }),
    );
  });

  it('fails when the install failed for another reason', async () => {
    const { proc, row } = setup({
      install: {
        status: CatalogInstallStatus.FAILED,
        errorMessage: 'image pull back-off',
      },
      physical: {
        standbyState: jest.fn(async () => ({ done: false, inRecovery: null })),
      },
    });
    await expect(proc.run(job)).rejects.toThrow(/image pull/);
    expect(row.status).toBe(DbMigrationStatus.FAILED);
  });

  it('cuts over: fence, LSN, replay, promote, then credentials and cleanup', async () => {
    const { proc, row, calls } = setup();
    await proc.run(job);
    expect(calls).toEqual([
      'open-transport',
      'verify-copy',
      'fence',
      'replay',
      'promote',
      'credentials',
      'finish-dst',
      'finish-src',
    ]);
    expect(row.status).toBe(DbMigrationStatus.COMPLETED);
    expect(row.fence).toMatchObject({
      fenceLsn: '0/5A000110',
      releasedAt: null,
    });
    expect(row.fence.promoteIssuedAt).toBeTruthy();
  });

  it('returns to SYNCED with the source unfenced when the cutover fails before promote', async () => {
    const { proc, row, calls, physical } = setup({
      mig: { status: DbMigrationStatus.SYNCED, linkId: 'l1', dstAppId: 'dst' },
      physical: {
        waitForReplay: jest.fn(async () => {
          throw new Error('did not replay in time');
        }),
      },
    });
    await proc.runCutover(job);
    expect(calls).toEqual(['fence', 'unfence']);
    expect(physical.promote).not.toHaveBeenCalled();
    expect(row.status).toBe(DbMigrationStatus.SYNCED);
    expect(row.errorMessage).toMatch(/before promote.*did not replay/);
    expect(row.fence.releasedAt).toBe('later');
  });

  it('refuses to fence when the destination is not a standby', async () => {
    const { proc, row, fence } = setup({
      mig: { status: DbMigrationStatus.SYNCED, linkId: 'l1', dstAppId: 'dst' },
      physical: { recoveryState: jest.fn(async () => 'unknown') },
    });
    await proc.runCutover(job);
    expect(fence.fence).not.toHaveBeenCalled();
    expect(row.status).toBe(DbMigrationStatus.SYNCED);
  });

  it('fails a link whose slot was lost, after unfencing nothing it did not fence', async () => {
    const { proc, row, fence } = setup({
      mig: { status: DbMigrationStatus.SYNCED, linkId: 'l1', dstAppId: 'dst' },
      physical: {
        status: jest.fn(async () => {
          throw new SlotLostError('slot lost');
        }),
      },
    });
    await proc.runCutover(job);
    expect(fence.fence).not.toHaveBeenCalled();
    expect(fence.unfence).not.toHaveBeenCalled();
    expect(row.status).toBe(DbMigrationStatus.FAILED);
  });

  it('asks promote once more when the destination is known to be a standby, then completes', async () => {
    const { proc, row, calls, physical } = setup({
      mig: { status: DbMigrationStatus.SYNCED, linkId: 'l1', dstAppId: 'dst' },
      physical: {
        promote: jest
          .fn()
          .mockRejectedValueOnce(new PromoteUnconfirmedError('returned f'))
          .mockImplementation(async () => calls.push('promote')),
      },
    });
    await proc.runCutover(job);
    expect(physical.promote).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([
      'fence',
      'replay',
      'promote',
      'credentials',
      'finish-dst',
      'finish-src',
    ]);
    expect(row.status).toBe(DbMigrationStatus.COMPLETED);
  });

  it('never unfences once promote was asked and the destination is still in recovery', async () => {
    const { proc, row, calls, queue, physical } = setup({
      mig: { status: DbMigrationStatus.SYNCED, linkId: 'l1', dstAppId: 'dst' },
      physical: {
        promote: jest.fn(async () => {
          throw new PromoteUnconfirmedError('pg_promote returned f');
        }),
      },
    });
    await proc.runCutover(job);
    expect(calls).toEqual(['fence', 'replay']);
    expect(physical.promote).toHaveBeenCalledTimes(2);
    expect(row.status).toBe(DbMigrationStatus.CUTOVER);
    expect(queue.add).toHaveBeenCalledWith(
      'run-db-cutover',
      { migrationId: 'm1' },
      expect.objectContaining({ delay: expect.any(Number) }),
    );
    expect(physical.finishOnSource).not.toHaveBeenCalled();
  });

  it('completes forward when promote errored but the destination is primary', async () => {
    const { proc, row } = setup({
      mig: { status: DbMigrationStatus.SYNCED, linkId: 'l1', dstAppId: 'dst' },
      physical: {
        recoveryState: jest
          .fn()
          .mockResolvedValueOnce('standby')
          .mockResolvedValue('primary'),
        promote: jest.fn(async () => {
          throw new Error('exec stream closed');
        }),
      },
    });
    await proc.runCutover(job);
    expect(row.status).toBe(DbMigrationStatus.COMPLETED);
  });

  it('does not promote when the migration was aborted during the drain, and lifts its own fence', async () => {
    const { proc, row, physical, calls } = setup({
      mig: { status: DbMigrationStatus.SYNCED, linkId: 'l1', dstAppId: 'dst' },
      physical: {
        waitForReplay: jest.fn(async () => {
          row.status = DbMigrationStatus.ABORTED;
        }),
      },
    });
    await proc.runCutover(job);
    expect(physical.promote).not.toHaveBeenCalled();
    expect(row.status).toBe(DbMigrationStatus.ABORTED);
    expect(calls).toEqual(['fence', 'unfence']);
  });

  it('stops without overwriting an abort that landed while the link was being built', async () => {
    const ctx = setup({ mig: { cutoverMode: DbCutoverMode.MANUAL } });
    ctx.physical.openTransport.mockImplementation(async () => {
      ctx.row.status = DbMigrationStatus.ABORTED;
    });
    await ctx.proc.run(job);
    expect(ctx.row.status).toBe(DbMigrationStatus.ABORTED);
    expect(ctx.physical.attachStandby).not.toHaveBeenCalled();
  });

  it('tears the link down when the run fails, and records what it could not clean', async () => {
    const { proc, row, physical } = setup({
      mig: { cutoverMode: DbCutoverMode.MANUAL },
      physical: {
        verifyCopy: jest.fn(async () => {
          throw new Error('collation differs');
        }),
        abort: jest.fn(async () => ({ notes: ['slot not dropped: busy'] })),
      },
    });
    await expect(proc.run(job)).rejects.toThrow(/collation differs/);
    expect(physical.abort).toHaveBeenCalledWith(
      expect.objectContaining({ id: link().id }),
    );
    expect(row.status).toBe(DbMigrationStatus.FAILED);
    expect(row.errorMessage).toMatch(/collation differs.*slot not dropped/);
  });

  it('fails without teardown when nothing was built yet', async () => {
    const { proc, row, physical, installer } = setup();
    installer.install.mockRejectedValue(new Error('no capacity'));
    await expect(proc.run(job)).rejects.toThrow(/no capacity/);
    expect(physical.abort).not.toHaveBeenCalled();
    expect(row.status).toBe(DbMigrationStatus.FAILED);
  });

  describe('a run delivered again after a restart', () => {
    it('resumes from REPLICATING without installing, creating a link or copying again', async () => {
      const { proc, row, physical, installer } = setup({
        mig: {
          status: DbMigrationStatus.REPLICATING,
          cutoverMode: DbCutoverMode.MANUAL,
          dstInstallId: 'inst-1',
          dstAppId: 'dst',
          linkId: link().id,
        },
      });
      await proc.run(job);
      expect(installer.install).not.toHaveBeenCalled();
      expect(physical.createLink).not.toHaveBeenCalled();
      expect(physical.openTransport).toHaveBeenCalled();
      expect(physical.attachStandby).not.toHaveBeenCalled();
      expect(row.status).toBe(DbMigrationStatus.SYNCED);
    });

    it('resumes from PROVISIONING after the install, creating the link once', async () => {
      const { proc, row, physical, installer } = setup({
        mig: {
          status: DbMigrationStatus.PROVISIONING,
          cutoverMode: DbCutoverMode.MANUAL,
          dstInstallId: 'inst-1',
        },
      });
      await proc.run(job);
      expect(installer.install).not.toHaveBeenCalled();
      expect(physical.createLink).toHaveBeenCalledTimes(1);
      expect(row.status).toBe(DbMigrationStatus.SYNCED);
    });
  });

  describe('a migration found in CUTOVER', () => {
    const cutover = (fence: any) => ({
      mig: {
        status: DbMigrationStatus.CUTOVER,
        linkId: 'l1',
        dstAppId: 'dst',
        fence,
      },
    });
    const fenced = {
      method: 'pg_hba',
      marker: 'flui:fence:0123456789ab',
      hbaSha256Before: 'h0',
      appliedAt: 'now',
      releasedAt: null,
    };

    it('rolls back to SYNCED when the destination is a standby and promote was never asked', async () => {
      const { proc, row, calls } = setup(cutover(fenced));
      await proc.runCutover(job);
      expect(calls).toEqual(['unfence']);
      expect(row.status).toBe(DbMigrationStatus.SYNCED);
    });

    it('completes when the destination is primary', async () => {
      const { proc, row, calls } = setup({
        ...cutover({ ...fenced, promoteIssuedAt: 'then' }),
        physical: { recoveryState: jest.fn(async () => 'primary') },
      });
      await proc.runCutover(job);
      expect(calls).toEqual(['credentials', 'finish-dst', 'finish-src']);
      expect(row.status).toBe(DbMigrationStatus.COMPLETED);
    });

    it('keeps the source fenced and retries when the destination cannot be asked', async () => {
      const { proc, row, calls, queue } = setup({
        ...cutover(fenced),
        physical: { recoveryState: jest.fn(async () => 'unknown') },
      });
      await proc.runCutover(job);
      expect(calls).toEqual([]);
      expect(row.status).toBe(DbMigrationStatus.CUTOVER);
      expect(queue.add).toHaveBeenCalled();
    });

    it('asks promote again when it was asked before and the destination is still a standby', async () => {
      const { proc, row, calls, fence } = setup(
        cutover({ ...fenced, promoteIssuedAt: 'then' }),
      );
      await proc.runCutover(job);
      expect(calls).toEqual([
        'promote',
        'credentials',
        'finish-dst',
        'finish-src',
      ]);
      expect(fence.unfence).not.toHaveBeenCalled();
      expect(row.status).toBe(DbMigrationStatus.COMPLETED);
    });

    it('keeps the source fenced when the repeated promote is not confirmed either', async () => {
      const { proc, row, queue, fence } = setup({
        ...cutover({ ...fenced, promoteIssuedAt: 'then' }),
        physical: {
          promote: jest.fn(async () => {
            throw new PromoteUnconfirmedError('returned f');
          }),
        },
      });
      await proc.runCutover(job);
      expect(fence.unfence).not.toHaveBeenCalled();
      expect(row.status).toBe(DbMigrationStatus.CUTOVER);
      expect(queue.add).toHaveBeenCalled();
    });

    it('does not ask promote again when a Postgres pod moved', async () => {
      const ctx = setup(cutover({ ...fenced, promoteIssuedAt: 'then' }));
      ctx.placement.nodeOfApp.mockImplementation(async (appId: string) => ({
        appId,
        clusterId: 'x',
        nodeId: 'elsewhere',
        overlayIp: '10.250.0.9',
      }));
      await ctx.proc.runCutover(job);
      expect(ctx.physical.promote).not.toHaveBeenCalled();
      expect(ctx.row.status).toBe(DbMigrationStatus.CUTOVER);
      expect(ctx.queue.add).toHaveBeenCalled();
    });
  });
});

describe('DbMigrationProcessor, physical cutover with paused poolers', () => {
  const plan = {
    poolers: [
      { appId: 'src', role: 'source' },
      { appId: 'dst', role: 'destination' },
    ],
    deadlineMs: 5000,
  };
  const synced = (extra: Record<string, any> = {}) => ({
    mig: {
      status: DbMigrationStatus.SYNCED,
      linkId: 'l1',
      dstAppId: 'dst',
      poolerCut: plan,
    },
    poolerCut: {},
    poolers: {},
    ...extra,
  });

  it('pauses, fences as the cut, promotes, then retargets and resumes only the destination', async () => {
    const { proc, row, calls, poolerCut } = setup(synced());
    await proc.runCutover(job);
    expect(calls).toEqual([
      'pause',
      'fence',
      'settle',
      'replay',
      'promote',
      'retarget+resume-dst',
      'suspend-src',
      'credentials',
      'bring-up-dst',
      'finish-dst',
      'finish-src',
    ]);
    expect(poolerCut!.resumeRoles).not.toHaveBeenCalled();
    expect(row.status).toBe(DbMigrationStatus.COMPLETED);
    expect(row.writesStoppedAt).toEqual(new Date('2026-10-12T10:00:00.000Z'));
    expect(row.writePauseMs).toBe(8500);
  });

  it('resumes both poolers and returns to SYNCED when the drain fails before promote', async () => {
    const { proc, row, calls, physical } = setup(
      synced({
        physical: {
          waitForReplay: jest.fn(async () => {
            throw new Error('did not replay in time');
          }),
        },
      }),
    );
    await proc.runCutover(job);
    expect(calls).toEqual([
      'pause',
      'fence',
      'settle',
      'unfence',
      'resume:source+destination:rollback',
    ]);
    expect(physical.promote).not.toHaveBeenCalled();
    expect(row.status).toBe(DbMigrationStatus.SYNCED);
  });

  it('never fences when a pooler cannot be paused, and lets every pooler through again', async () => {
    const { proc, row, calls, fence } = setup(
      synced({
        poolerCut: {
          pause: jest.fn(async (m: any) => {
            m.poolerCut = {
              ...m.poolerCut,
              pausedPods: [{ appId: 'src', pod: 'src-pooler-1' }],
            };
            throw new Error('exec failed on dst-pooler-1');
          }),
        },
      }),
    );
    await proc.runCutover(job);
    expect(fence.fence).not.toHaveBeenCalled();
    expect(calls).toEqual(['resume:source+destination:rollback']);
    expect(row.status).toBe(DbMigrationStatus.SYNCED);
    expect(row.errorMessage).toMatch(/exec failed on dst-pooler-1/);
  });

  it('lets the poolers through when an abort lands during the drain', async () => {
    const ctx = setup(
      synced({
        physical: {
          waitForReplay: jest.fn(async () => {
            ctx.row.status = DbMigrationStatus.ABORTED;
          }),
        },
      }),
    );
    await ctx.proc.runCutover(job);
    expect(ctx.physical.promote).not.toHaveBeenCalled();
    expect(ctx.calls).toEqual([
      'pause',
      'fence',
      'settle',
      'unfence',
      'resume:source+destination:abort',
    ]);
  });

  it('completes with a note, and never resumes against the source, when the destination pooler cannot be retargeted', async () => {
    const { proc, row, calls, poolerCut } = setup(
      synced({
        poolerCut: {
          retargetAndResume: jest.fn(async () => {
            throw new Error(
              'Pooler pod dst-pooler-1 does not reach the promoted destination',
            );
          }),
        },
      }),
    );
    await proc.runCutover(job);
    expect(row.status).toBe(DbMigrationStatus.COMPLETED);
    expect(row.errorMessage).toMatch(/destination pooler: .*does not reach/);
    expect(poolerCut!.resumeRoles).not.toHaveBeenCalled();
    expect(calls).toContain('suspend-src');
  });

  it('behaves as today without a plan, even with the pooler service present', async () => {
    const { proc, row, calls, poolerCut } = setup(
      synced({
        mig: {
          status: DbMigrationStatus.SYNCED,
          linkId: 'l1',
          dstAppId: 'dst',
        },
      }),
    );
    await proc.runCutover(job);
    expect(poolerCut!.pause).not.toHaveBeenCalled();
    expect(poolerCut!.retargetAndResume).not.toHaveBeenCalled();
    expect(calls).toEqual([
      'fence',
      'replay',
      'promote',
      'credentials',
      'bring-up-dst',
      'finish-dst',
      'finish-src',
    ]);
  });

  describe('after an API restart during the pause', () => {
    const paused = {
      ...plan,
      pausedPods: [
        { appId: 'src', pod: 'src-pooler-1' },
        { appId: 'dst', pod: 'dst-pooler-1' },
      ],
      pausedAt: '2026-10-12T10:00:00.000Z',
    };
    const fence = {
      method: 'pg_hba',
      marker: 'flui:fence:0123456789ab',
      hbaSha256Before: 'h0',
      appliedAt: '2026-10-12T10:00:05.000Z',
      releasedAt: null,
    };

    it('unfences and resumes both poolers when the destination is still a standby and promote was never asked', async () => {
      const { proc, row, calls } = setup({
        mig: {
          status: DbMigrationStatus.CUTOVER,
          linkId: 'l1',
          dstAppId: 'dst',
          fence,
          poolerCut: paused,
        },
        poolerCut: {},
      });
      await proc.runCutover(job);
      expect(calls).toEqual(['unfence', 'resume:source+destination:rollback']);
      expect(row.status).toBe(DbMigrationStatus.SYNCED);
    });

    it('retargets and resumes only the destination when it is already primary', async () => {
      const { proc, row, calls, poolerCut } = setup({
        mig: {
          status: DbMigrationStatus.CUTOVER,
          linkId: 'l1',
          dstAppId: 'dst',
          fence: { ...fence, promoteIssuedAt: 'then' },
          poolerCut: paused,
        },
        poolerCut: {},
        physical: { recoveryState: jest.fn(async () => 'primary') },
      });
      await proc.runCutover(job);
      expect(calls).toEqual([
        'retarget+resume-dst',
        'suspend-src',
        'credentials',
        'finish-dst',
        'finish-src',
      ]);
      expect(poolerCut!.resumeRoles).not.toHaveBeenCalled();
      expect(row.status).toBe(DbMigrationStatus.COMPLETED);
    });

    it('keeps both poolers paused while the destination cannot be asked', async () => {
      const { proc, row, calls, poolerCut } = setup({
        mig: {
          status: DbMigrationStatus.CUTOVER,
          linkId: 'l1',
          dstAppId: 'dst',
          fence: { ...fence, promoteIssuedAt: 'then' },
          poolerCut: paused,
        },
        poolerCut: {},
        physical: { recoveryState: jest.fn(async () => 'unknown') },
      });
      await proc.runCutover(job);
      expect(calls).toEqual([]);
      expect(poolerCut!.resumeRoles).not.toHaveBeenCalled();
      expect(row.status).toBe(DbMigrationStatus.CUTOVER);
    });
  });
});

function link() {
  return { id: '0123456789ab-0000' };
}
