jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { DbMigrationProcessor } from './db-migration.processor';
import { DbMigrationStatus } from '../enums/db-migration.enum';
import { DbReplicationKind } from '../enums/db-replication-status.enum';

const T0 = new Date('2026-10-11T10:00:00.000Z');
const at = (ms: number) => new Date(T0.getTime() + ms);

function setup(row: any) {
  const migRepo = {
    save: jest.fn(async (m: any) => Object.assign(row, m)),
    update: jest.fn(async (_id: string, partial: any) => {
      Object.assign(row, partial);
      return { affected: 1 };
    }),
  };
  const repl = {
    fence: jest.fn(async () => jest.setSystemTime(at(200))),
    terminateWriters: jest.fn(async () => undefined),
    replicationStatus: jest.fn(async () => ({ lagBytes: 0 })),
    promote: jest.fn(async () => jest.setSystemTime(at(2700))),
  };
  const physical = {
    markPromoted: jest.fn(async () => undefined),
    finishOnDestination: jest.fn(async () => undefined),
    finishOnSource: jest.fn(async () => undefined),
  };
  const handoff = { adoptSourceCredentials: jest.fn(async () => undefined) };
  const proc = new DbMigrationProcessor(
    migRepo as any,
    { update: jest.fn() } as any,
    {} as any,
    {} as any,
    {} as any,
    repl as any,
    {} as any,
    {} as any,
    physical as any,
    {} as any,
    {} as any,
    {} as any,
    handoff as any,
    {} as any,
    {} as any,
    { add: jest.fn() } as any,
  );
  return { proc, migRepo };
}

describe('DbMigrationProcessor write pause', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(T0);
  });
  afterEach(() => jest.useRealTimers());

  it('measures a physical migration from the fence to the confirmed promote, and persists it at once', async () => {
    const row: any = {
      id: 'm1',
      kind: DbReplicationKind.PHYSICAL,
      status: DbMigrationStatus.CUTOVER,
      srcAppId: 'src',
      dstAppId: 'dst',
      fence: { appliedAt: T0.toISOString(), promoteIssuedAt: at(3000) },
    };
    const { proc, migRepo } = setup(row);
    jest.setSystemTime(at(3400));

    await (proc as any).completion.completePhysical(row, { id: 'l1' });

    expect(migRepo.update).toHaveBeenCalledWith('m1', {
      writesStoppedAt: T0,
      promoteConfirmedAt: at(3400),
      writePauseMs: 3400,
    });
    expect(row.writePauseMs).toBe(3400);
    expect(row.status).toBe(DbMigrationStatus.COMPLETED);
  });

  it('keeps the first confirmation when a resumed cutover completes again', async () => {
    const row: any = {
      id: 'm1',
      kind: DbReplicationKind.PHYSICAL,
      status: DbMigrationStatus.CUTOVER,
      fence: { appliedAt: T0.toISOString() },
      promoteConfirmedAt: at(1500),
      writePauseMs: 1500,
    };
    const { proc } = setup(row);
    jest.setSystemTime(at(90_000));

    await (proc as any).completion.completePhysical(row, { id: 'l1' });

    expect(row.promoteConfirmedAt).toEqual(at(1500));
    expect(row.writePauseMs).toBe(1500);
  });

  it('leaves the pause unknown when the fence record has no usable start', async () => {
    const row: any = {
      id: 'm1',
      kind: DbReplicationKind.PHYSICAL,
      status: DbMigrationStatus.CUTOVER,
      fence: { appliedAt: 'now' },
    };
    const { proc } = setup(row);

    await (proc as any).completion.completePhysical(row, { id: 'l1' });

    expect(row.promoteConfirmedAt).toEqual(T0);
    expect(row.writePauseMs).toBeNull();
  });

  it('measures a logical migration from its fence to its promote', async () => {
    const row: any = {
      id: 'm2',
      kind: DbReplicationKind.LOGICAL,
      status: DbMigrationStatus.SYNCED,
      srcAppId: 'src',
      linkId: 'l2',
      verifyRowCounts: false,
    };
    const { proc } = setup(row);

    await (proc as any).logical.performCutover(row);

    expect(row.writesStoppedAt).toEqual(at(200));
    expect(row.promoteConfirmedAt).toEqual(at(2700));
    expect(row.writePauseMs).toBe(2500);
    expect(row.status).toBe(DbMigrationStatus.COMPLETED);
  });
});
