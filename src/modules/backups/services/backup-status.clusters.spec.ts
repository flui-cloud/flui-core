// The status service reaches the Kubernetes client only through the engine
// registry behind the needs-decision reader, which is left out here.
jest.mock('@kubernetes/client-node', () => ({}));

import { BackupStatusService } from './backup-status.service';

function build() {
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
  };
  const clusterRepo = {
    find: jest.fn().mockResolvedValue([{ id: 'control-live' }]),
  };
  const policyRepo = {
    find: jest.fn().mockResolvedValue([
      {
        id: 'auto-daily',
        name: 'auto-daily',
        clusterId: 'old-9b32',
        enabled: true,
        status: 'active',
      },
      {
        id: 'fixture',
        name: 'nightly-fixture',
        clusterId: 'old-9b32',
        enabled: true,
        status: 'active',
      },
    ]),
  };
  const service = new BackupStatusService(
    clusterRepo as never,
    policyRepo as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    { createQueryBuilder: jest.fn().mockReturnValue(qb) } as never,
    { find: jest.fn().mockResolvedValue([]) } as never,
    null as never,
  );
  return { service, clusterRepo };
}

describe('BackupStatusService — which clusters count', () => {
  it('does not count a deleted cluster, nor call a live one protected by its policies', async () => {
    const { service, clusterRepo } = build();
    const status = await service.getStatus('u1');
    expect(clusterRepo.find.mock.calls[0][0].where.status).toBeDefined();
    expect(status.summary).toMatchObject({
      clustersTotal: 1,
      clustersWithBackups: 0,
      clustersWithoutBackups: 1,
      activePolicies: 0,
    });
    expect(status.alerts.map((a) => a.code)).toEqual(
      expect.arrayContaining(['CLUSTERS_WITHOUT_BACKUPS', 'ORPHAN_POLICIES']),
    );
    const orphans = status.alerts.find((a) => a.code === 'ORPHAN_POLICIES');
    expect(orphans?.message).toContain('auto-daily, nightly-fixture');
    expect(orphans?.items).toEqual([
      {
        id: 'auto-daily',
        name: 'auto-daily',
        path: '/management/backup/policies/auto-daily',
      },
      {
        id: 'fixture',
        name: 'nightly-fixture',
        path: '/management/backup/policies/fixture',
      },
    ]);
  });
});

describe('BackupStatusService — what needs a decision', () => {
  it('lists each live cluster with its protection and the volumes waiting on a person', async () => {
    const qb = {
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([]),
    };
    const item = {
      clusterId: 'wc-1',
      applicationId: 'mongo',
      name: 'mongo',
      slug: 'mongo',
      reason: 'mongodb has no consistent backup in Flui yet',
      source: 'engine',
      options: ['stop_during_copy', 'leave_out'],
    };
    const service = new BackupStatusService(
      {
        find: jest.fn().mockResolvedValue([
          { id: 'wc-1', name: 'workload' },
          { id: 'ctl', name: 'control' },
        ]),
      } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      { createQueryBuilder: jest.fn().mockReturnValue(qb) } as never,
      { find: jest.fn().mockResolvedValue([]) } as never,
      null as never,
      {
        find: jest.fn().mockResolvedValue([
          {
            clusterId: 'wc-1',
            applications: {
              pg: { outcome: 'waiting', at: 'now' },
              api: { outcome: 'protected', at: 'now' },
            },
          },
        ]),
      } as never,
      {
        forClusters: jest.fn().mockResolvedValue(new Map([['wc-1', [item]]])),
      } as never,
    );
    const status = await service.getStatus('u1');
    expect(status.clusters).toEqual([
      {
        clusterId: 'wc-1',
        name: 'workload',
        protected: true,
        needsDecision: [item],
        pending: 1,
      },
      {
        clusterId: 'ctl',
        name: 'control',
        protected: false,
        needsDecision: [],
        pending: 0,
      },
    ]);
    expect(status.summary.needsDecision).toBe(1);
    expect(status.alerts.map((a) => a.code)).toContain('VOLUMES_NEED_DECISION');
  });
});
