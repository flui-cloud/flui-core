import { AppProtectionService } from './app-protection.service';

function build(opts: {
  coverage: unknown;
  artifacts?: Array<{ jobId: string; at: string; sizeBytes: string | null }>;
}) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'innerJoin',
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'limit',
  ]) {
    qb[m] = jest.fn(() => qb);
  }
  qb.getRawMany = jest.fn(async () => opts.artifacts ?? []);
  const policiesQb: Record<string, jest.Mock> = {};
  for (const m of ['leftJoinAndSelect', 'where', 'orderBy']) {
    policiesQb[m] = jest.fn(() => policiesQb);
  }
  policiesQb.getMany = jest.fn(async () => []);
  const service = new AppProtectionService(
    { createQueryBuilder: jest.fn(() => policiesQb) } as never,
    { findByPolicy: jest.fn(async () => []) } as never,
    { findById: jest.fn() } as never,
    { forApplicationId: jest.fn(async () => opts.coverage) } as never,
    { createQueryBuilder: jest.fn(() => qb) } as never,
  );
  return { service, qb };
}

describe('AppProtectionService.lastBackupSizeBytes', () => {
  it('sums what the newest backup of the covering policy wrote for the app', async () => {
    const { service, qb } = build({
      coverage: { policy: { id: 'p1' } },
      artifacts: [
        { jobId: 'j2', at: '2026-09-27T03:00:00Z', sizeBytes: '2048' },
        { jobId: 'j1', at: '2026-09-26T03:00:00Z', sizeBytes: '4096' },
      ],
    });
    const result = await service.forApplication('app-1');
    expect(result.lastBackupSizeBytes).toBe(2048);
    expect(qb.andWhere).toHaveBeenCalledWith('j."policyId" = :policyId', {
      policyId: 'p1',
    });
  });

  it('is null when no policy covers the app, without reading artifacts', async () => {
    const { service, qb } = build({ coverage: { policy: null } });
    const result = await service.forApplication('app-1');
    expect(result.lastBackupSizeBytes).toBeNull();
    expect(qb.getRawMany).not.toHaveBeenCalled();
  });

  it('is null when the covering backup was not written per application', async () => {
    const { service } = build({ coverage: { policy: { id: 'cluster' } } });
    expect(
      (await service.forApplication('app-1')).lastBackupSizeBytes,
    ).toBeNull();
  });
});
