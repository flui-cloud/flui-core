jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { FullMigrationService } from './full-migration.service';
import { FullMigrationStatus } from '../enums/full-migration.enum';

function setup(rows: any[], liveIds: string[] = []) {
  const fmRepo = {
    find: jest.fn(async () => rows),
    findOne: jest.fn(async ({ where }: any) =>
      rows.find((r) => r.id === where.id),
    ),
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

const cutover = (id: string) => ({
  id,
  status: FullMigrationStatus.CUTOVER,
  updatedAt: new Date(1),
});

describe('FullMigrationService cutover resume', () => {
  it('queues again at startup a cutover no job holds', async () => {
    const { svc, queue } = setup([cutover('fm-1'), cutover('fm-2')], ['fm-2']);
    await svc.onModuleInit();
    expect(queue.add).toHaveBeenCalledTimes(1);
    expect(queue.add).toHaveBeenCalledWith(
      'run-full-cutover',
      { migrationId: 'fm-1' },
      { jobId: 'resume-cutover:fm-1:1' },
    );
  });

  it('lets a person resume a cutover no job holds, and refuses one still running', async () => {
    const free = setup([cutover('fm-1')]);
    await free.svc.cutover('fm-1');
    expect(free.queue.add).toHaveBeenCalled();

    const busy = setup([cutover('fm-1')], ['fm-1']);
    await expect(busy.svc.cutover('fm-1')).rejects.toThrow(
      'still cutting over',
    );
  });
});

describe('FullMigrationService views', () => {
  it('tells the surfaces a cutover can be resumed only when no job holds it', async () => {
    const free = setup([cutover('fm-1')]);
    expect((await free.svc.getView('fm-1')).canResumeCutover).toBe(true);
    const busy = setup([cutover('fm-1')], ['fm-1']);
    expect((await busy.svc.getView('fm-1')).canResumeCutover).toBe(false);
  });
});
