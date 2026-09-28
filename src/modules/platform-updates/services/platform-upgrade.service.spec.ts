jest.mock('@kubernetes/client-node', () => ({}));

import { BadRequestException, ConflictException } from '@nestjs/common';
import { RELEASE } from '../../../config/release.config';
import { PlatformUpgradeService } from './platform-upgrade.service';
import {
  OperationStatus,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  PlatformUpgradeMetadata,
  WITHOUT_BACKUP_ACKNOWLEDGEMENT,
} from '../interfaces/platform-upgrade.interface';

const TARGET = '99.0.0';
const K3S = 'v1.36.1+k3s1';

function status() {
  return {
    installedVersion: RELEASE.version,
    availableVersion: TARGET,
    updateAvailable: true,
    applicable: true,
    requiredCliVersion: TARGET,
    publishedAt: null,
    notes: [],
    migrations: 2,
    components: [
      {
        key: 'fluiWeb',
        name: 'Flui Web',
        installedVersion: '1.0.0',
        targetVersion: TARGET,
        changed: true,
      },
      {
        key: 'fluiAuthz',
        name: 'Flui Authz',
        installedVersion: '0.6.0',
        targetVersion: '0.6.0',
        changed: false,
      },
      {
        key: 'fluiApi',
        name: 'Flui API',
        installedVersion: RELEASE.version,
        targetVersion: TARGET,
        changed: true,
      },
    ],
    advisories: [],
    checkedAt: '',
    checkError: null,
  };
}

const CLUSTERS = [
  {
    id: 'w1',
    name: 'work-1',
    clusterType: 'workload',
    kubeconfigEncrypted: 'x',
  },
  {
    id: 'ctl',
    name: 'control',
    clusterType: 'control',
    kubeconfigEncrypted: 'x',
  },
];

interface Opts {
  policy?: { id: string; name: string; userId?: string } | null;
  manifestPlanId?: string;
  controllerMissingOn?: string;
  running?: unknown;
  operation?: unknown;
  jobState?: string;
  missingKeyOn?: string;
}

function build(opts: Opts = {}) {
  const platformUpdates = {
    getStatus: jest.fn().mockResolvedValue(status()),
    imageRefsFor: jest.fn().mockResolvedValue({
      fluiWeb: `ghcr.io/flui-cloud/dashboard:${TARGET}`,
      fluiAuthz: 'ghcr.io/flui-cloud/flui-authz:0.6.0',
      fluiApi: `ghcr.io/flui-cloud/core:${TARGET}`,
    }),
  };
  const releases = {
    getManifest: jest.fn().mockResolvedValue({
      manifest: {
        schemaVersion: 2,
        releases: [
          {
            version: TARGET,
            bootstrapRef: 'ref-99',
            migrations: 2,
            k3s: { version: K3S },
          },
        ],
      },
    }),
  };
  const manifests = {
    plan: jest.fn(({ clusterId }: { clusterId: string }) =>
      Promise.resolve({
        ref: 'ref-99',
        planId: `${opts.manifestPlanId ?? 'mp'}-${clusterId}`,
        clusterId,
        entries: [
          { name: '00-a.yaml', action: 'replace', releaseSha: 's1' },
          ...(clusterId === opts.controllerMissingOn
            ? [
                {
                  name: '02-system-upgrade-controller.yaml',
                  action: 'add',
                  releaseSha: 's2',
                },
              ]
            : []),
          { name: '09-x.yaml', action: 'skip', reason: 'secret' },
          ...(clusterId === opts.missingKeyOn
            ? [
                {
                  name: '04d-alertmanager.yaml',
                  action: 'skip',
                  reason: 'reads the Secret',
                  missingSecretKeys: [
                    'flui-system/flui-secrets/ALERTS_WEBHOOK_TOKEN',
                  ],
                },
              ]
            : []),
        ],
      }),
    ),
  };
  const k3s = {
    plan: jest.fn().mockResolvedValue([
      {
        clusterId: 'w1',
        clusterName: 'work-1',
        clusterType: 'workload',
        observedVersion: 'v1.35.4+k3s1',
        steps: [K3S],
        nodes: [],
        upToDate: false,
        blockers:
          opts.controllerMissingOn === 'w1'
            ? [
                'The system-upgrade-controller is not installed on this cluster.',
              ]
            : [],
      },
      {
        clusterId: 'ctl',
        clusterName: 'control',
        clusterType: 'control',
        observedVersion: 'v1.35.4+k3s1',
        steps: [K3S],
        nodes: [],
        upToDate: false,
        blockers: [],
      },
    ]),
  };
  const saved: any[] = [];
  let locked = false;
  const runner = {
    findRunning: jest.fn(async () => opts.running ?? null),
    exclusive: jest.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      if (locked) throw new ConflictException('busy');
      locked = true;
      try {
        return await work({
          findRunning: async () =>
            saved.find((o) => o.status === OperationStatus.PENDING) ??
            opts.running ??
            null,
          save: async (v: unknown) => {
            saved.push(v);
            return v;
          },
        });
      } finally {
        locked = false;
      }
    }),
  };
  const clusters = { find: jest.fn().mockResolvedValue(CLUSTERS) };
  const policies = {
    findOne: jest
      .fn()
      .mockResolvedValue(
        opts.policy === undefined
          ? { id: 'pol-1', name: 'platform', userId: 'owner-1' }
          : opts.policy,
      ),
  };
  const operations = {
    create: jest.fn((v) => ({ id: 'op-9', ...v })),
    save: jest.fn((v) => {
      saved.push(v);
      return Promise.resolve(v);
    }),
    findOne: jest.fn().mockResolvedValue(opts.operation ?? null),
  };
  const queue = {
    add: jest.fn(),
    getJob: jest.fn(async () =>
      opts.jobState ? { getState: async () => opts.jobState } : null,
    ),
  };
  const audit = { record: jest.fn().mockResolvedValue(undefined) };
  const service = new PlatformUpgradeService(
    platformUpdates as never,
    releases as never,
    manifests as never,
    k3s as never,
    runner as never,
    clusters as never,
    policies as never,
    operations as never,
    queue as never,
    audit as never,
  );
  return { service, manifests, queue, audit, saved, operations };
}

const actor = { userId: 'u1', email: 'op@example.com', actorKind: 'user' };

describe('PlatformUpgradeService.plan', () => {
  it('lays the update out by phase, in the order it runs', async () => {
    const { service } = build();
    const plan = await service.plan(TARGET);
    expect(plan.phases.map((p) => p.key)).toEqual([
      'backup',
      'manifests',
      'images',
      'k3s',
      'verify',
    ]);
    expect(plan.bootstrapRef).toBe('ref-99');
    expect(plan.k3sVersion).toBe(K3S);
    expect(plan.applicable).toBe(true);
  });

  it('refreshes manifests on the control first, and upgrades K3s on the control last', async () => {
    const { service, manifests } = build();
    const plan = await service.plan(TARGET);
    const m = plan.phases.find((p) => p.key === 'manifests');
    const k = plan.phases.find((p) => p.key === 'k3s');
    expect(m?.clusters?.map((c) => c.clusterId)).toEqual(['ctl', 'w1']);
    expect(k?.clusters?.map((c) => c.clusterId)).toEqual(['w1', 'ctl']);
    expect(manifests.plan).toHaveBeenCalledWith({
      ref: 'ref-99',
      clusterId: 'ctl',
    });
  });

  it('gives the same plan id twice for the same state, and a new one when a cluster plan moves', async () => {
    const first = await build().service.plan(TARGET);
    const again = await build().service.plan(TARGET);
    const moved = await build({ manifestPlanId: 'other' }).service.plan(TARGET);
    expect(again.planId).toBe(first.planId);
    expect(moved.planId).not.toBe(first.planId);
  });

  it('names a missing platform backup as the one blocker an acknowledgement passes', async () => {
    const { service } = build({ policy: null });
    const plan = await service.plan(TARGET);
    expect(plan.blockers).toEqual([
      expect.objectContaining({ phase: 'backup', overridable: true }),
    ]);
    expect(plan.applicable).toBe(true);
    expect(plan.acknowledgement).toBe(WITHOUT_BACKUP_ACKNOWLEDGEMENT);
  });

  it('stops on a Secret it would have to copy from a key that is not there', async () => {
    const { service } = build({ missingKeyOn: 'ctl' });
    const plan = await service.plan(TARGET);
    expect(plan.blockers).toEqual([
      expect.objectContaining({
        phase: 'manifests',
        message: expect.stringContaining(
          'flui-system/flui-secrets/ALERTS_WEBHOOK_TOKEN',
        ),
      }),
    ]);
    expect(plan.applicable).toBe(false);
  });

  it('says so when the platform backup has nobody to run it as', async () => {
    const { service } = build({ policy: { id: 'pol-1', name: 'platform' } });
    const plan = await service.plan(TARGET);
    expect(plan.blockers).toEqual([
      expect.objectContaining({
        phase: 'backup',
        message: expect.stringMatching(/no owner/),
      }),
    ]);
  });

  it('does not block K3s on a missing upgrade controller that the manifests phase installs', async () => {
    const { service } = build({ controllerMissingOn: 'w1' });
    const plan = await service.plan(TARGET);
    expect(plan.blockers).toEqual([]);
  });
});

describe('PlatformUpgradeService.apply', () => {
  it('refuses a plan id that no longer matches, and writes nothing', async () => {
    const { service, saved, queue } = build();
    await expect(
      service.apply({ targetVersion: TARGET, planId: 'stale' }, actor),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(saved).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('records one operation with every phase, in order, and queues it', async () => {
    const { service, saved, queue } = build();
    const { planId } = await service.plan(TARGET);
    await service.apply({ targetVersion: TARGET, planId }, actor);

    const op = saved[0];
    expect(op.operationType).toBe(OperationType.UPDATE_PLATFORM);
    expect(op.status).toBe(OperationStatus.PENDING);
    const meta = op.metadata as PlatformUpgradeMetadata;
    expect(meta.schema).toBe(2);
    expect(meta.planId).toBe(planId);
    expect(meta.phases.map((p) => [p.key, p.status])).toEqual([
      ['backup', 'pending'],
      ['manifests', 'pending'],
      ['images', 'pending'],
      ['k3s', 'pending'],
      ['verify', 'pending'],
    ]);
    expect(meta.phases[1].clusters?.map((c) => c.planId)).toEqual([
      'mp-ctl',
      'mp-w1',
    ]);
    expect(meta.phases[3].clusters?.map((c) => c.clusterId)).toEqual([
      'w1',
      'ctl',
    ]);
    expect(queue.add).toHaveBeenCalledWith(
      'run-platform-upgrade',
      { operationId: 'op-9' },
      expect.objectContaining({ attempts: 1 }),
    );
  });

  it('refuses to go without a backup unless told to, in the words of the acknowledgement', async () => {
    const { service, saved } = build({ policy: null });
    const { planId } = await service.plan(TARGET);
    await expect(
      service.apply({ targetVersion: TARGET, planId }, actor),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.apply(
        {
          targetVersion: TARGET,
          planId,
          withoutBackup: true,
          acknowledgement: 'ok',
        },
        actor,
      ),
    ).rejects.toThrow(WITHOUT_BACKUP_ACKNOWLEDGEMENT);
    expect(saved).toHaveLength(0);
  });

  it('records an acknowledged update without backup in the operation and in the audit log', async () => {
    const { service, saved, audit } = build({ policy: null });
    const { planId } = await service.plan(TARGET);
    await service.apply(
      {
        targetVersion: TARGET,
        planId,
        withoutBackup: true,
        acknowledgement: WITHOUT_BACKUP_ACKNOWLEDGEMENT,
      },
      actor,
    );
    const meta = saved[0].metadata as PlatformUpgradeMetadata;
    expect(meta.withoutBackup).toBe(true);
    expect(meta.acknowledgement).toBe(WITHOUT_BACKUP_ACKNOWLEDGEMENT);
    expect(meta.phases[0].status).toBe('skipped');
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        action: 'platform update without backup',
        dataAccess: false,
        outcome: 'ok',
        target: expect.objectContaining({ operationId: 'op-9' }),
      }),
    );
  });

  it('records one operation when the same plan is applied twice at once', async () => {
    const { service, saved } = build();
    const { planId } = await service.plan(TARGET);
    await Promise.allSettled([
      service.apply({ targetVersion: TARGET, planId }, actor),
      service.apply({ targetVersion: TARGET, planId }, actor),
    ]);
    expect(saved).toHaveLength(1);
  });

  it('does not write to the audit log for an update with its backup', async () => {
    const { service, audit } = build();
    const { planId } = await service.plan(TARGET);
    await service.apply({ targetVersion: TARGET, planId }, actor);
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('PlatformUpgradeService.resume', () => {
  const failed = () => ({
    id: 'op-9',
    status: OperationStatus.FAILED,
    metadata: {
      schema: 2,
      planId: 'p',
      targetVersion: TARGET,
      fromVersion: RELEASE.version,
      migrations: 0,
      bootstrapRef: 'ref-99',
      k3sVersion: K3S,
      withoutBackup: false,
      failedPhase: 'k3s',
      guidance: 'K3s is never downgraded.',
      components: [],
      phases: [
        { key: 'backup', title: 'b', status: 'done' },
        { key: 'manifests', title: 'm', status: 'done' },
        { key: 'images', title: 'i', status: 'done' },
        {
          key: 'k3s',
          title: 'k',
          status: 'failed',
          clusters: [
            {
              clusterId: 'w1',
              clusterName: 'work-1',
              clusterType: 'workload',
              status: 'done',
            },
            {
              clusterId: 'ctl',
              clusterName: 'control',
              clusterType: 'control',
              status: 'failed',
            },
          ],
        },
        { key: 'verify', title: 'v', status: 'pending' },
      ],
    },
  });

  it('starts the failed phase again from the cluster it reached', async () => {
    const { service, saved, queue } = build({ operation: failed() });
    await service.resume('op-9');
    const meta = saved[0].metadata as PlatformUpgradeMetadata;
    expect(saved[0].status).toBe(OperationStatus.IN_PROGRESS);
    expect(meta.failedPhase).toBeUndefined();
    expect(meta.phases[2].status).toBe('done');
    expect(meta.phases[3].status).toBe('pending');
    expect(meta.phases[3].clusters?.map((c) => c.status)).toEqual([
      'done',
      'pending',
    ]);
    expect(queue.add).toHaveBeenCalled();
  });

  it('refuses while the worker still runs the update', async () => {
    const { service, queue, saved } = build({
      operation: failed(),
      jobState: 'active',
    });
    await expect(service.resume('op-9')).rejects.toThrow(/still running/);
    expect(saved).toHaveLength(0);
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('refuses an update that already finished', async () => {
    const { service } = build({
      operation: { ...failed(), status: OperationStatus.COMPLETED },
    });
    await expect(service.resume('op-9')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses an image-only update, which has no phases to resume', async () => {
    const { service } = build({
      operation: {
        id: 'op-9',
        status: OperationStatus.FAILED,
        metadata: { targetVersion: TARGET, components: [] },
      },
    });
    await expect(service.resume('op-9')).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
