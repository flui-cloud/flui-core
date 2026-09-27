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
        clusterId: 'old-9b32',
        enabled: true,
        status: 'active',
      },
      { id: 'fixture', clusterId: 'old-9b32', enabled: true, status: 'active' },
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
  });
});
