jest.mock('../../common/leadership/advisory-lock', () =>
  jest.requireActual('../../common/leadership/testing/fake-advisory-locks'),
);

import {
  resetFakeLocks,
  takenLocks,
} from '../../common/leadership/testing/fake-advisory-locks';
import { DbMigrationRecoveryService } from './db-migration-recovery.service';
import { DbMigrationStatus } from '../enums/db-migration.enum';

function setup(rows: any[], jobs: any[] = []) {
  const queue = {
    add: jest.fn(),
    getJobs: jest.fn(async () => jobs),
  };
  const migRepo = {
    manager: {},
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

const UPDATED = new Date('2026-10-17T08:00:00.000Z');

describe('DbMigrationRecoveryService', () => {
  beforeEach(() => resetFakeLocks());

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
    expect(queue.add).toHaveBeenCalledWith(
      'run-db-cutover',
      { migrationId: 'b' },
      { jobId: 'resume-cutover:b:0' },
    );
  });

  it('names each resumed job after the row it resumes, so two copies queue it once', async () => {
    const { svc, queue } = setup([
      { id: 'a', status: DbMigrationStatus.REPLICATING, updatedAt: UPDATED },
      { id: 'b', status: DbMigrationStatus.CUTOVER, updatedAt: UPDATED },
    ]);
    await svc.onApplicationBootstrap();
    expect(queue.add.mock.calls.map((c) => c[2].jobId)).toEqual([
      `resume-run:a:${UPDATED.getTime()}`,
      `resume-cutover:b:${UPDATED.getTime()}`,
    ]);
  });

  it('lets one copy at a time look for interrupted migrations', async () => {
    const order: string[] = [];
    let release!: () => void;
    const first = setup([{ id: 'a', status: DbMigrationStatus.PENDING }]);
    first.queue.getJobs.mockImplementationOnce(async () => {
      order.push('first:start');
      await new Promise<void>((r) => (release = r));
      order.push('first:end');
      return [];
    });
    const second = setup([]);
    second.queue.getJobs.mockImplementationOnce(async () => {
      order.push('second');
      return [];
    });
    const a = first.svc.onApplicationBootstrap();
    const b = second.svc.onApplicationBootstrap();
    await new Promise((r) => setImmediate(r));
    expect(order).toEqual(['first:start']);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
    expect(takenLocks).toEqual([
      'db-migration-recovery',
      'db-migration-recovery',
    ]);
  });
});
