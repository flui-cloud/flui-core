import { ApplicationsRepository } from './applications.repository';
import { ApplicationStatus } from '../enums/application-status.enum';

function repositoryWith(observed: unknown[], orphaned: unknown[]) {
  const clauses: string[] = [];
  const builder = {
    leftJoinAndSelect: jest.fn().mockReturnThis(),
    where: jest.fn((clause: string) => (clauses.push(clause), builder)),
    andWhere: jest.fn((clause: string) => (clauses.push(clause), builder)),
    getMany: jest.fn().mockResolvedValue(orphaned),
  };
  const typeorm = {
    find: jest.fn().mockResolvedValue(observed),
    createQueryBuilder: jest.fn().mockReturnValue(builder),
  };
  return {
    repo: new ApplicationsRepository(typeorm as never),
    clauses,
  };
}

describe('the apps the periodic check looks at', () => {
  it('adds apps left reading updating with nothing updating them', async () => {
    const { repo } = repositoryWith(
      [{ id: 'a', status: ApplicationStatus.RUNNING }],
      [{ id: 'b', status: ApplicationStatus.UPDATING }],
    );

    const apps = await repo.findObservableByCluster('c-1');

    expect(apps.map((app) => app.id)).toEqual(['a', 'b']);
  });

  it('leaves alone an app whose deploy is still in flight, or that changed a moment ago', async () => {
    const { repo, clauses } = repositoryWith([], []);

    await repo.findOrphanedUpdates('c-1');

    const sql = clauses.join('\n');
    expect(sql).toContain("op.status IN ('PENDING', 'IN_PROGRESS')");
    expect(sql).toContain('NOT EXISTS');
    expect(sql).toContain('make_interval');
    expect(sql).toContain('app.clusterId = :clusterId');
  });
});
