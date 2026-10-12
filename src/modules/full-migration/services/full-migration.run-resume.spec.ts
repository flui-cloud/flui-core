jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { FullMigrationService } from './full-migration.service';
import {
  FullCutoverMode,
  FullMigrationStatus,
} from '../enums/full-migration.enum';

function setup(rows: any[], liveIds: string[] = []) {
  const fmRepo = {
    find: jest.fn(async () => rows),
  };
  const queue = {
    add: jest.fn(async () => undefined),
    getJobs: jest.fn(async () =>
      liveIds.map((id) => ({ data: { migrationId: id } })),
    ),
  };
  const svc = new FullMigrationService(
    fmRepo as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    queue as any,
  );
  return { svc, queue };
}

const row = (id: string, status: FullMigrationStatus, over = {}) => ({
  id,
  status,
  cutoverMode: FullCutoverMode.MANUAL,
  updatedAt: new Date(7),
  ...over,
});

describe('FullMigrationService run resume at startup', () => {
  it('queues the run again for a pre-cutover migration no job holds', async () => {
    const { svc, queue } = setup(
      [
        row('a', FullMigrationStatus.PENDING),
        row('b', FullMigrationStatus.DB_REPLICATING),
        row('c', FullMigrationStatus.APP_STAGING),
        row('d', FullMigrationStatus.DB_REPLICATING),
      ],
      ['d'],
    );
    await svc.onModuleInit();
    expect(
      queue.add.mock.calls
        .filter((c: any[]) => c[0] === 'run-full-migration')
        .map((c: any[]) => [c[1].migrationId, c[2].jobId]),
    ).toEqual([
      ['a', 'resume-run:a:7'],
      ['b', 'resume-run:b:7'],
      ['c', 'resume-run:c:7'],
    ]);
  });

  it('resumes a READY migration only when it was meant to cut over by itself', async () => {
    const { svc, queue } = setup([
      row('m', FullMigrationStatus.READY),
      row('a', FullMigrationStatus.READY, {
        cutoverMode: FullCutoverMode.AUTO,
      }),
    ]);
    await svc.onModuleInit();
    expect(queue.add.mock.calls.map((c: any[]) => c[1].migrationId)).toEqual([
      'a',
    ]);
  });

  it('never queues a run for a migration past the cutover', async () => {
    const { svc, queue } = setup([
      row('x', FullMigrationStatus.COMPLETED),
      row('y', FullMigrationStatus.ABORTED),
      row('z', FullMigrationStatus.FAILED),
    ]);
    await svc.onModuleInit();
    expect(queue.add).not.toHaveBeenCalled();
  });
});
