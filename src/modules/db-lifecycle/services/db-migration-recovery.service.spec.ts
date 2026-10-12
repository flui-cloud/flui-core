import { DbMigrationRecoveryService } from './db-migration-recovery.service';
import { DbMigrationStatus } from '../enums/db-migration.enum';

function setup(rows: any[], jobs: any[] = []) {
  const queue = {
    add: jest.fn(),
    getJobs: jest.fn(async () => jobs),
  };
  const migRepo = {
    find: jest.fn(async ({ where }: any) =>
      rows.filter((r) =>
        Array.isArray(where.status?._value)
          ? where.status._value.includes(r.status)
          : r.status === where.status,
      ),
    ),
  };
  return {
    svc: new DbMigrationRecoveryService(migRepo as any, queue as any),
    queue,
  };
}

describe('DbMigrationRecoveryService', () => {
  it('re-enqueues a physical run left in provisioning or replicating when no job carries it', async () => {
    const { svc, queue } = setup([
      { id: 'a', status: DbMigrationStatus.PROVISIONING },
      { id: 'b', status: DbMigrationStatus.REPLICATING },
      { id: 'c', status: DbMigrationStatus.PENDING },
    ]);
    await svc.onApplicationBootstrap();
    expect(queue.add.mock.calls.map((c) => [c[0], c[1].migrationId])).toEqual([
      ['run-db-migration', 'a'],
      ['run-db-migration', 'b'],
      ['run-db-migration', 'c'],
    ]);
  });

  it('leaves a run that Bull still holds as active, waiting or delayed', async () => {
    const { svc, queue } = setup(
      [
        { id: 'a', status: DbMigrationStatus.REPLICATING },
        { id: 'b', status: DbMigrationStatus.CUTOVER },
      ],
      [
        { name: 'run-db-migration', data: { migrationId: 'a' } },
        { name: 'run-db-cutover', data: { migrationId: 'b' } },
      ],
    );
    await svc.onApplicationBootstrap();
    expect(queue.add).not.toHaveBeenCalled();
    expect(queue.getJobs).toHaveBeenCalledWith([
      'active',
      'waiting',
      'delayed',
    ]);
  });

  it('hands a cutover back to the cutover job', async () => {
    const { svc, queue } = setup([
      { id: 'b', status: DbMigrationStatus.CUTOVER },
    ]);
    await svc.onApplicationBootstrap();
    expect(queue.add).toHaveBeenCalledWith('run-db-cutover', {
      migrationId: 'b',
    });
  });
});
