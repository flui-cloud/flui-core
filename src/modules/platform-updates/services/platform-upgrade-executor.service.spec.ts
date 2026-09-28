jest.mock('@kubernetes/client-node', () => ({}));

import { PlatformUpgradeExecutorService } from './platform-upgrade-executor.service';
import { PlatformUpgradeChecksService } from './platform-upgrade-checks.service';
import { PlatformUpgradeRecordsService } from './platform-upgrade-records.service';
import { OperationStatus } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { BackupJobStatus } from '../../backups/enums/backup-job.enum';
import {
  PlatformUpgradeMetadata,
  UpgradePhaseKey,
  UpgradePhaseStatus,
} from '../interfaces/platform-upgrade.interface';
import { continuedAfterRestart } from '../utils/upgrade-state.util';

const TARGET = '99.0.0';
const K3S = 'v1.36.1+k3s1';

function metadata(
  over: {
    statuses?: Partial<Record<UpgradePhaseKey, UpgradePhaseStatus>>;
    apiMoves?: boolean;
    withoutBackup?: boolean;
    migrations?: number;
  } = {},
): PlatformUpgradeMetadata {
  const s = over.statuses ?? {};
  return {
    schema: 2,
    planId: 'plan-1',
    fromVersion: '1.0.0',
    targetVersion: TARGET,
    bootstrapRef: 'ref-99',
    k3sVersion: K3S,
    migrations: over.migrations ?? 0,
    withoutBackup: over.withoutBackup ?? false,
    components: [
      {
        key: 'fluiWeb',
        name: 'Flui Web',
        fromVersion: '1.0.0',
        targetVersion: TARGET,
        imageRef: `web:${TARGET}`,
        status: 'pending',
      },
      {
        key: 'fluiApi',
        name: 'Flui API',
        fromVersion: '1.0.0',
        targetVersion: TARGET,
        imageRef: `api:${TARGET}`,
        status: over.apiMoves ? 'pending' : 'skipped',
      },
    ],
    phases: [
      {
        key: 'backup',
        title: 'Backup',
        status: over.withoutBackup ? 'skipped' : (s.backup ?? 'pending'),
        policyId: 'pol-1',
      },
      {
        key: 'manifests',
        title: 'Manifests',
        status: s.manifests ?? 'pending',
        clusters: [
          {
            clusterId: 'ctl',
            clusterName: 'control',
            clusterType: 'control',
            planId: 'mp-ctl',
            approved: [{ name: 'a.yaml', action: 'replace', releaseSha: '1' }],
            status: s.manifests === 'done' ? 'done' : 'pending',
          },
          {
            clusterId: 'w1',
            clusterName: 'work-1',
            clusterType: 'workload',
            planId: 'mp-w1',
            approved: [{ name: 'a.yaml', action: 'replace', releaseSha: '1' }],
            status: s.manifests === 'done' ? 'done' : 'pending',
          },
        ],
      },
      { key: 'images', title: 'Images', status: s.images ?? 'pending' },
      {
        key: 'k3s',
        title: 'K3s',
        status: s.k3s ?? 'pending',
        clusters: [
          {
            clusterId: 'w1',
            clusterName: 'work-1',
            clusterType: 'workload',
            status: s.k3s === 'done' ? 'done' : 'pending',
          },
          {
            clusterId: 'ctl',
            clusterName: 'control',
            clusterType: 'control',
            status: s.k3s === 'done' ? 'done' : 'pending',
          },
        ],
      },
      { key: 'verify', title: 'Verify', status: s.verify ?? 'pending' },
    ],
  };
}

interface Setup {
  meta?: PlatformUpgradeMetadata;
  runningVersion?: string;
  backupStatus?: BackupJobStatus;
  freshFiles?: Array<{ name: string; action: string; releaseSha: string }>;
  webInstalled?: string;
  k3sFailsOn?: string;
  verifyFails?: boolean;
  status?: OperationStatus;
  pinFails?: boolean;
  apiRunning?: string;
  declaredStale?: boolean;
  userId?: string | null;
  policyOwner?: string | null;
  backupJobs?: Record<string, BackupJobStatus>;
}

function build(setup: Setup = {}) {
  const calls: string[] = [];
  let row: any = {
    id: 'op-1',
    status: setup.status ?? OperationStatus.PENDING,
    userId: setup.userId === undefined ? 'u1' : setup.userId,
    metadata: setup.meta ?? metadata(),
  };
  const clone = (v: unknown) => JSON.parse(JSON.stringify(v));
  const operations = {
    findOne: jest.fn(() => Promise.resolve(clone(row))),
    save: jest.fn((v) => {
      row = clone(v);
      return Promise.resolve(v);
    }),
    update: jest.fn((_id, patch) => {
      row = { ...row, ...clone(patch) };
      return Promise.resolve();
    }),
  };
  const backupJobs = {
    findOne: jest.fn(({ where }) =>
      Promise.resolve({
        id: where.id,
        status:
          setup.backupJobs?.[where.id] ??
          setup.backupStatus ??
          BackupJobStatus.COMPLETED,
        errorMessage: 'bucket unreachable',
      }),
    ),
  };
  const clusters = {
    findOne: jest.fn(({ where }) =>
      Promise.resolve({
        id: where.id,
        name: where.id,
        kubeconfigEncrypted: 'enc',
      }),
    ),
    find: jest.fn().mockResolvedValue([
      {
        id: 'ctl',
        name: 'control',
        clusterType: 'control',
        kubeconfigEncrypted: 'e',
      },
      {
        id: 'w1',
        name: 'work-1',
        clusterType: 'workload',
        kubeconfigEncrypted: 'e',
      },
    ]),
  };
  const backupJobsService = {
    createOnDemand: jest.fn((userId: string) => {
      calls.push(`backup:${userId}`);
      return Promise.resolve({ id: 'job-1' });
    }),
  };
  const declaredImages = {
    pin: jest.fn((image: string) => {
      calls.push(`declare:${image}`);
      return Promise.resolve(
        setup.pinFails
          ? {
              pinned: false,
              outcome: 'failed',
              files: [],
              reason: '09-flui-api.yaml could not be read back',
            }
          : { pinned: true, outcome: 'written', files: ['09-flui-api.yaml'] },
      );
    }),
    check: jest.fn(() =>
      Promise.resolve(
        setup.declaredStale
          ? { pinned: false, outcome: 'failed', files: [], reason: 'stale' }
          : { pinned: true, outcome: 'already', files: ['09-flui-api.yaml'] },
      ),
    ),
  };
  const policies = {
    findOne: jest.fn(() =>
      Promise.resolve(
        setup.policyOwner === null
          ? null
          : { id: 'pol-1', userId: setup.policyOwner ?? 'owner-1' },
      ),
    ),
  };
  const manifests = {
    plan: jest.fn(({ clusterId }) =>
      Promise.resolve({
        planId: `fresh-${clusterId}`,
        entries: setup.freshFiles ?? [
          { name: 'a.yaml', action: 'replace', releaseSha: '1' },
        ],
      }),
    ),
    apply: jest.fn(({ clusterId }) => {
      calls.push(`manifests:${clusterId}`);
      return Promise.resolve({ wrote: ['a.yaml'], backupPath: '/b' });
    }),
  };
  const images = {
    rollout: jest.fn((c) => {
      calls.push(`image:${c.key}`);
      return Promise.resolve();
    }),
    replaceControlPlane: jest.fn(() => {
      calls.push('image:fluiApi');
      return Promise.resolve();
    }),
  };
  const platformUpdates = {
    getStatus: jest.fn().mockResolvedValue({
      components: [
        { key: 'fluiWeb', installedVersion: setup.webInstalled ?? '1.0.0' },
        { key: 'fluiApi', installedVersion: '1.0.0' },
      ],
    }),
    componentAppIds: jest.fn().mockResolvedValue(
      new Map([
        ['fluiWeb', 'app-web'],
        ['fluiApi', 'app-api'],
      ]),
    ),
  };
  const upgraded = new Set<string>();
  const k3s = {
    plan: jest.fn(),
    run: jest.fn((_op: string, clusterId: string) => {
      calls.push(`k3s:${clusterId}`);
      upgraded.add(clusterId);
      if (clusterId === setup.k3sFailsOn) {
        return Promise.reject(new Error('node ctl-1 failed the upgrade'));
      }
      return Promise.resolve({ status: 'done' });
    }),
  };
  k3s.plan = jest.fn((clusterId: string) =>
    Promise.resolve([
      {
        clusterId,
        clusterName: clusterId,
        clusterType: 'workload',
        upToDate: upgraded.has(clusterId) && !setup.verifyFails,
        steps: [],
        nodes: [
          {
            name: `${clusterId}-1`,
            role: 'server',
            kubeletVersion: K3S,
            ready: true,
          },
        ],
        controller: { installed: true, ready: true },
        blockers: [],
      },
    ]),
  ) as never;
  const encryption = { decrypt: jest.fn(() => 'kubeconfig') };

  const checks = new PlatformUpgradeChecksService(
    clusters as never,
    k3s as never,
    {} as never,
    encryption as never,
    declaredImages as never,
  );
  const service = new PlatformUpgradeExecutorService(
    backupJobs as never,
    policies as never,
    new PlatformUpgradeRecordsService(operations as never),
    backupJobsService as never,
    manifests as never,
    images as never,
    platformUpdates as never,
    k3s as never,
    declaredImages as never,
    checks,
  );
  service.sleep = () => Promise.resolve();
  service.runningVersion = setup.runningVersion ?? TARGET;
  checks.systemPort = () => ({
    deployments: () =>
      Promise.resolve(
        setup.verifyFails
          ? [{ namespace: 'kube-system', name: 'traefik', available: false }]
          : [{ namespace: 'kube-system', name: 'traefik', available: true }],
      ),
    deployment: () =>
      Promise.resolve({
        images: [setup.apiRunning ?? `api:${TARGET}`],
        available: true,
      }),
  });
  return {
    service,
    calls,
    row: () => row as { status: string; metadata: PlatformUpgradeMetadata },
    manifests,
    images,
    backupJobsService,
    k3s,
    declaredImages,
  };
}

const phaseStatus = (meta: PlatformUpgradeMetadata) =>
  meta.phases.map((p) => [p.key, p.status]);

describe('PlatformUpgradeExecutorService', () => {
  it('runs backup, manifests (control first), images, K3s (control last) and checks, then completes', async () => {
    const { service, calls, row } = build();
    await service.execute('op-1');

    expect(calls).toEqual([
      'backup:u1',
      'manifests:ctl',
      'manifests:w1',
      'image:fluiWeb',
      'k3s:w1',
      `declare:web:${TARGET}`,
      'k3s:ctl',
    ]);
    expect(row().status).toBe(OperationStatus.COMPLETED);
    expect(phaseStatus(row().metadata)).toEqual([
      ['backup', 'done'],
      ['manifests', 'done'],
      ['images', 'done'],
      ['k3s', 'done'],
      ['verify', 'done'],
    ]);
    expect(row().metadata.phases[0].backupJobId).toBe('job-1');
  });

  it('gives each phase a deadline while it runs', async () => {
    const { service, row, manifests } = build();
    let seen: string | undefined;
    manifests.apply.mockImplementationOnce(() => {
      seen = row().metadata.phases[1].deadlineAt;
      return Promise.resolve({ wrote: [], backupPath: '' });
    });
    const before = Date.now();
    await service.execute('op-1');
    expect(Date.parse(seen as string)).toBeGreaterThan(before);
    for (const p of row().metadata.phases) {
      expect(p.startedAt).toBeDefined();
    }
  });

  it('stops everything when the backup fails', async () => {
    const { service, calls, row } = build({
      backupStatus: BackupJobStatus.FAILED,
    });
    await service.execute('op-1');
    expect(calls).toEqual(['backup:u1']);
    expect(row().status).toBe(OperationStatus.FAILED);
    expect(row().metadata.failedPhase).toBe('backup');
    expect(row().metadata.guidance).toMatch(/Nothing was changed/);
  });

  it('goes on without a backup only when that was acknowledged', async () => {
    const { service, backupJobsService, row } = build({
      meta: metadata({ withoutBackup: true }),
    });
    await service.execute('op-1');
    expect(backupJobsService.createOnDemand).not.toHaveBeenCalled();
    expect(row().status).toBe(OperationStatus.COMPLETED);
  });

  it('parks at the API: the old pod replaces it and does nothing more', async () => {
    const { service, calls, row } = build({
      meta: metadata({ apiMoves: true }),
      runningVersion: '1.0.0',
    });
    await service.execute('op-1');
    expect(calls.slice(-2)).toEqual(['image:fluiWeb', 'image:fluiApi']);
    expect(calls).not.toContain('k3s:w1');
    expect(row().status).toBe(OperationStatus.IN_PROGRESS);
    expect(row().metadata.awaitingSelfRestart).toBe(true);
    expect(row().metadata.phases[2].status).toBe('running');
  });

  it('continues in the new pod with K3s and the checks', async () => {
    const parked = metadata({
      apiMoves: true,
      statuses: { backup: 'done', manifests: 'done', images: 'running' },
    });
    parked.components = parked.components.map((c) => ({
      ...c,
      status: c.key === 'fluiApi' ? 'running' : 'done',
    }));
    const { service, calls, row } = build({
      meta: continuedAfterRestart(parked, new Date()),
      runningVersion: TARGET,
    });
    await service.execute('op-1');
    expect(calls).toEqual([
      'k3s:w1',
      `declare:api:${TARGET}`,
      `declare:web:${TARGET}`,
      'k3s:ctl',
    ]);
    expect(row().status).toBe(OperationStatus.COMPLETED);
  });

  it('does nothing twice: a rerun skips phases done and targets already reached', async () => {
    const { service, calls, manifests, row } = build({
      meta: metadata({ statuses: { backup: 'done' } }),
      freshFiles: [{ name: 'a.yaml', action: 'unchanged', releaseSha: '1' }],
      webInstalled: TARGET,
    });
    await service.execute('op-1');
    expect(manifests.apply).not.toHaveBeenCalled();
    expect(calls).toEqual(['k3s:w1', `declare:web:${TARGET}`, 'k3s:ctl']);
    expect(row().status).toBe(OperationStatus.COMPLETED);
  });

  it('refuses to write a manifest nobody previewed, and says where the copies are', async () => {
    const { service, manifests, row } = build({
      meta: metadata({ statuses: { backup: 'done' } }),
      freshFiles: [{ name: 'new.yaml', action: 'add', releaseSha: '7' }],
    });
    await service.execute('op-1');
    expect(manifests.apply).not.toHaveBeenCalled();
    expect(row().status).toBe(OperationStatus.FAILED);
    expect(row().metadata.failedPhase).toBe('manifests');
    expect(row().metadata.phases[1].clusters?.[0].status).toBe('failed');
    expect(row().metadata.guidance).toContain('flui-refresh-backup/mp-ctl');
  });

  it('keeps the cluster K3s reached, never downgrades, and names the backup once migrations ran', async () => {
    const { service, row } = build({
      meta: metadata({
        statuses: { backup: 'done', manifests: 'done', images: 'done' },
        migrations: 3,
      }),
      k3sFailsOn: 'ctl',
    });
    const meta = row().metadata;
    meta.phases[0].backupJobId = 'job-1';
    await service.execute('op-1');
    const after = row().metadata;
    expect(row().status).toBe(OperationStatus.FAILED);
    expect(after.failedPhase).toBe('k3s');
    expect(after.phases[3].clusters?.map((c) => c.status)).toEqual([
      'done',
      'failed',
    ]);
    expect(after.guidance).toMatch(/never downgraded/i);
    expect(after.guidance).toContain('job-1');
  });

  it('fails the checks when a system component is not available', async () => {
    const { service, row } = build({
      meta: metadata({
        statuses: {
          backup: 'done',
          manifests: 'done',
          images: 'done',
          k3s: 'done',
        },
      }),
      verifyFails: true,
    });
    service.now = (() => {
      let t = Date.now();
      return () => (t += 60 * 60_000);
    })();
    await service.execute('op-1');
    expect(row().status).toBe(OperationStatus.FAILED);
    expect(row().metadata.failedPhase).toBe('verify');
    const checks = row().metadata.phases[4].checks ?? [];
    expect(checks.some((c) => !c.ok && /traefik/i.test(c.name))).toBe(true);
  });

  it('leaves an update that already stopped alone', async () => {
    const { service, calls, row } = build({ status: OperationStatus.FAILED });
    await service.execute('op-1');
    expect(calls).toEqual([]);
    expect(row().status).toBe(OperationStatus.FAILED);
  });

  it('declares the target API image on the control master before K3s restarts it', async () => {
    const { service, calls, declaredImages } = build({
      meta: metadata({
        apiMoves: true,
        statuses: { backup: 'done', manifests: 'done', images: 'done' },
      }),
    });
    await service.execute('op-1');
    const k3sCtl = calls.indexOf('k3s:ctl');
    expect(calls.indexOf(`declare:api:${TARGET}`)).toBeGreaterThan(
      calls.indexOf('k3s:w1'),
    );
    expect(calls.indexOf(`declare:api:${TARGET}`)).toBeLessThan(k3sCtl);
    expect(declaredImages.pin).toHaveBeenCalledWith(`api:${TARGET}`, {
      images: expect.arrayContaining(['api:1.0.0']),
    });
  });

  it('refuses to restart the control when the API image cannot be declared', async () => {
    const { service, calls, row } = build({
      meta: metadata({
        apiMoves: true,
        statuses: { backup: 'done', manifests: 'done', images: 'done' },
      }),
      pinFails: true,
    });
    await service.execute('op-1');
    expect(calls).not.toContain('k3s:ctl');
    expect(row().status).toBe(OperationStatus.FAILED);
    expect(row().metadata.failedPhase).toBe('k3s');
    expect(row().metadata.error).toMatch(/could not be read back/);
  });

  it('checks the API the cluster runs and the one the master declares, not this process', async () => {
    const done = {
      backup: 'done',
      manifests: 'done',
      images: 'done',
      k3s: 'done',
    } as const;
    const expire = (s: PlatformUpgradeExecutorService) => {
      s.now = (() => {
        let t = Date.now();
        return () => (t += 60 * 60_000);
      })();
    };
    const old = build({
      meta: metadata({ apiMoves: true, statuses: done }),
      apiRunning: 'api:1.0.0',
    });
    expire(old.service);
    await old.service.execute('op-1');
    expect(old.row().metadata.failedPhase).toBe('verify');
    expect(old.row().metadata.error).toMatch(/API/);

    const stale = build({
      meta: metadata({ apiMoves: true, statuses: done }),
      declaredStale: true,
    });
    expire(stale.service);
    await stale.service.execute('op-1');
    expect(stale.row().metadata.error).toMatch(/declare/i);

    const good = build({
      meta: metadata({
        apiMoves: true,
        statuses: { backup: 'done', manifests: 'done', images: 'done' },
      }),
    });
    await good.service.execute('op-1');
    expect(good.row().status).toBe(OperationStatus.COMPLETED);
  });

  it('takes a fresh backup when the one recorded ended without completing', async () => {
    const meta = metadata();
    meta.phases[0].backupJobId = 'job-old';
    const { service, backupJobsService, row } = build({
      meta,
      backupJobs: { 'job-old': BackupJobStatus.FAILED },
    });
    await service.execute('op-1');
    expect(backupJobsService.createOnDemand).toHaveBeenCalledTimes(1);
    expect(row().metadata.phases[0].backupJobId).toBe('job-1');
    expect(row().status).toBe(OperationStatus.COMPLETED);
  });

  it('runs the backup as the owner of the policy when nobody is recorded on the update', async () => {
    const owned = build({ userId: null });
    await owned.service.execute('op-1');
    expect(owned.calls[0]).toBe('backup:owner-1');

    const orphan = build({ userId: null, policyOwner: null });
    await orphan.service.execute('op-1');
    expect(orphan.row().status).toBe(OperationStatus.FAILED);
    expect(orphan.row().metadata.error).toMatch(/nobody to run/i);
  });

  it('gives K3s a deadline from every cluster, step and node the plan names', async () => {
    const meta = metadata({
      statuses: { backup: 'done', manifests: 'done', images: 'done' },
    });
    meta.phases[3].clusters = meta.phases[3].clusters?.map((c) => ({
      ...c,
      stepCount: 2,
      nodeCount: 4,
    }));
    const { service, row, k3s } = build({ meta });
    let seen: { startedAt?: string; deadlineAt?: string } = {};
    const run = k3s.run.getMockImplementation() as (
      ...args: [string, string]
    ) => Promise<{ status: string }>;
    k3s.run.mockImplementationOnce((...args: [string, string]) => {
      seen = { ...row().metadata.phases[3] };
      return run(...args);
    });
    await service.execute('op-1');
    const budget =
      Date.parse(seen.deadlineAt as string) -
      Date.parse(seen.startedAt as string);
    const perCluster = 10 * 60_000 + 2 * (10 * 60_000 + 20 * 60_000 * 4);
    expect(budget).toBe(2 * perCluster);
  });
});
