jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { FullMigrationProcessor } from './full-migration.processor';
import { DbMigrationStatus } from '../../db-lifecycle/enums/db-migration.enum';
import { DbReplicationKind } from '../../db-lifecycle/enums/db-replication-status.enum';
import {
  FullMigrationStatus,
  FullStagingMode,
} from '../enums/full-migration.enum';

function setup(dbChild: any) {
  const fm: any = {
    id: 'fm-1',
    appId: 'app-1',
    dbAppId: 'db-a',
    dbMigrationId: 'dbm-1',
    appMigrationId: 'am-1',
    stagingMode: FullStagingMode.LIVE_FENCED,
    rewirePlan: { env: [] },
  };
  const repl = { fence: jest.fn(), unfence: jest.fn(async () => undefined) };
  const rewire = {
    computeRewirePlan: jest.fn(() => ({ env: [{ name: 'X', value: 'y' }] })),
  };
  const ops = {
    waitDb: jest.fn(async () => {
      throw new Error('boom');
    }),
    fail: jest.fn(async () => undefined),
  };
  const dbMig = {
    cutover: jest.fn(async () => undefined),
    abort: jest.fn(async () => undefined),
  };
  const proc = new FullMigrationProcessor(
    { save: jest.fn(async (e: any) => e) } as any,
    { findOne: jest.fn(async () => dbChild) } as any,
    { findOne: jest.fn(async () => null) } as any,
    { findById: jest.fn(async (id: string) => ({ id, env: [] })) } as any,
    dbMig as any,
    repl as any,
    { abort: jest.fn(async () => undefined) } as any,
    {} as any,
    rewire as any,
    ops as any,
  );
  return { proc, fm, repl, rewire, ops };
}

describe('FullMigrationProcessor with a physical db leg', () => {
  const physical = (over: any = {}) => ({
    id: 'dbm-1',
    dstAppId: 'db-b',
    kind: DbReplicationKind.PHYSICAL,
    status: DbMigrationStatus.SYNCED,
    ...over,
  });

  it('stages live-fenced against the hot standby with the source credentials', async () => {
    const { proc, fm, rewire } = setup(physical());
    const plan = await (proc as any).legs.stageLiveFenced(fm);
    expect(plan.physical).toBe(true);
    expect(rewire.computeRewirePlan).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: 'db-a' }),
      expect.objectContaining({ id: 'db-b' }),
      {
        credentialsFrom: expect.objectContaining({ id: 'db-a' }),
        secretRefs: false,
      },
    );
  });

  it('never unfences the destination on abort', async () => {
    const { proc, fm, repl } = setup(physical());
    await (proc as any).legs.abortChildren(fm);
    expect(repl.unfence).not.toHaveBeenCalled();
  });

  it('treats a physical cutover that never asked for promote as abortable', async () => {
    const { proc, fm, ops } = setup(
      physical({ status: DbMigrationStatus.CUTOVER, fence: {} }),
    );
    await expect((proc as any).promoteDbLeg(fm, physical())).rejects.toThrow();
    expect(ops.fail).toHaveBeenCalledWith(
      fm,
      expect.anything(),
      FullMigrationStatus.FAILED,
    );
  });

  it('goes forward once promote was asked', async () => {
    const { proc, fm, ops } = setup(
      physical({
        status: DbMigrationStatus.CUTOVER,
        fence: { promoteIssuedAt: '2026-10-11T20:00:00Z' },
      }),
    );
    await expect((proc as any).promoteDbLeg(fm, physical())).rejects.toThrow();
    expect(ops.fail).toHaveBeenCalledWith(
      fm,
      expect.anything(),
      FullMigrationStatus.FAILED_FORWARD,
    );
  });
});
