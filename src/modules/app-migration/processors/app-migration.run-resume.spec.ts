jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { AppMigrationProcessor } from './app-migration.processor';
import {
  AppCutoverMode,
  AppMigrationStatus,
} from '../enums/app-migration.enum';

function setup(status: AppMigrationStatus) {
  const row: any = {
    id: 'am-1',
    srcAppId: 'app-1',
    targetClusterId: 'dst',
    cutoverMode: AppCutoverMode.MANUAL,
    status,
  };
  const migRepo = {
    findOne: jest.fn(async () => ({ ...row })),
    save: jest.fn(async (m: any) => Object.assign(row, m)),
  };
  const materializer = {
    materializeOnCluster: jest.fn(async () => undefined),
    teardownOnCluster: jest.fn(async () => undefined),
  };
  const proc = new AppMigrationProcessor(
    migRepo as any,
    { update: jest.fn() } as any,
    {
      findOne: jest.fn(async () => ({ id: 'app-1', clusterId: 'src' })),
    } as any,
    {} as any,
    materializer as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
  );
  (proc as any).prepareBridge = jest.fn(async () => undefined);
  return { proc, row, materializer };
}

const job = { data: { migrationId: 'am-1' } } as any;

describe('AppMigrationProcessor run, delivered again', () => {
  it('resumes a run left in PROVISIONING and reaches READY', async () => {
    const { proc, row, materializer } = setup(AppMigrationStatus.PROVISIONING);
    await proc.run(job);
    expect(materializer.materializeOnCluster).toHaveBeenCalledTimes(1);
    expect(row.status).toBe(AppMigrationStatus.READY);
  });

  it.each([
    AppMigrationStatus.READY,
    AppMigrationStatus.CUTOVER,
    AppMigrationStatus.BRIDGING,
    AppMigrationStatus.COMPLETED,
    AppMigrationStatus.ABORTED,
  ])('never rewinds a migration in %s back to provisioning', async (status) => {
    const { proc, row, materializer } = setup(status);
    await proc.run(job);
    expect(materializer.materializeOnCluster).not.toHaveBeenCalled();
    expect(row.status).toBe(status);
  });

  it('does not provision twice when the job comes back while this process still runs it', async () => {
    const ctx = setup(AppMigrationStatus.PENDING);
    let release!: () => void;
    ctx.materializer.materializeOnCluster.mockImplementationOnce(
      () => new Promise<undefined>((r) => (release = () => r(undefined))),
    );
    const first = ctx.proc.run(job);
    await new Promise((r) => setImmediate(r));
    await ctx.proc.run(job);
    release();
    await first;
    expect(ctx.materializer.materializeOnCluster).toHaveBeenCalledTimes(1);
  });
});
