import {
  closePoliciesOfDeletedApplication,
  describeBackupsAfterRemoval,
} from './deleted-application-backups.util';

function policiesRepo(rows: any[]) {
  const qb = {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
    getCount: jest.fn().mockResolvedValue(rows.length),
  };
  return {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    save: jest.fn().mockResolvedValue(undefined),
  };
}

describe('backups of a deleted application', () => {
  it('stops its policy and marks why, keeping the policy and its backups', async () => {
    const policy = { id: 'p1', enabled: true, status: 'active', metadata: {} };
    const repo = policiesRepo([policy]);
    const closed = await closePoliciesOfDeletedApplication(
      repo as never,
      { id: 'app-1', name: 'pg-bgs' },
      new Date('2026-09-26T21:23:59Z'),
    );
    expect(closed).toBe(1);
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
        status: 'paused',
        metadata: {
          sourceDeleted: {
            at: '2026-09-26T21:23:59.000Z',
            applicationId: 'app-1',
            applicationName: 'pg-bgs',
          },
        },
      }),
    );
  });

  it('tells the person deleting that saved backups stay and the policy stops', async () => {
    const artifacts = {
      createQueryBuilder: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        getOne: jest.fn().mockResolvedValue({
          createdAt: new Date('2026-09-26T21:18:07Z'),
          expiresAt: null,
        }),
      }),
    };
    const sentence = await describeBackupsAfterRemoval(
      policiesRepo([{ id: 'p1' }]) as never,
      artifacts as never,
      ['app-1'],
    );
    expect(sentence).toContain('stay in the backup storage');
    expect(sentence).toContain('2026-09-26 21:18');
    expect(sentence).toContain('backup policy stops');
  });
});
