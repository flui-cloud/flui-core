import { DbReplicationKind } from '../../db-lifecycle/enums/db-replication-status.enum';
import { DbMigrationStatus } from '../../db-lifecycle/enums/db-migration.enum';
import {
  dbReplicateTimeoutMs,
  isPhysical,
  promotedDespiteError,
} from './full-migration-run.core';

const leg = (over: any = {}): any => ({
  kind: DbReplicationKind.LOGICAL,
  status: DbMigrationStatus.CUTOVER,
  ...over,
});

describe('full-migration run core', () => {
  const saved = process.env.FLUI_DB_BASE_BACKUP_TIMEOUT_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.FLUI_DB_BASE_BACKUP_TIMEOUT_MS;
    else process.env.FLUI_DB_BASE_BACKUP_TIMEOUT_MS = saved;
  });

  it('gives a logical leg 75 minutes to replicate', () => {
    expect(dbReplicateTimeoutMs(leg())).toBe(75 * 60 * 1000);
  });

  it('gives a physical leg six hours unless the base backup timeout is set', () => {
    delete process.env.FLUI_DB_BASE_BACKUP_TIMEOUT_MS;
    const physical = leg({ kind: DbReplicationKind.PHYSICAL });
    expect(dbReplicateTimeoutMs(physical)).toBe(6 * 60 * 60 * 1000);
    process.env.FLUI_DB_BASE_BACKUP_TIMEOUT_MS = '1234';
    expect(dbReplicateTimeoutMs(physical)).toBe(1234);
    process.env.FLUI_DB_BASE_BACKUP_TIMEOUT_MS = '-5';
    expect(dbReplicateTimeoutMs(physical)).toBe(6 * 60 * 60 * 1000);
  });

  it('tells a physical leg apart', () => {
    expect(isPhysical(leg({ kind: DbReplicationKind.PHYSICAL }))).toBe(true);
    expect(isPhysical(leg())).toBe(false);
    expect(isPhysical(null)).toBe(false);
  });

  it('counts a completed leg, or a logical one in cutover, as promoted', () => {
    expect(promotedDespiteError(null)).toBe(false);
    expect(
      promotedDespiteError(leg({ status: DbMigrationStatus.COMPLETED })),
    ).toBe(true);
    expect(promotedDespiteError(leg())).toBe(true);
    expect(
      promotedDespiteError(leg({ status: DbMigrationStatus.SYNCED })),
    ).toBe(false);
  });

  it('counts a physical leg in cutover as promoted only once the promote was asked', () => {
    const physical = (fence: any) =>
      leg({ kind: DbReplicationKind.PHYSICAL, fence });
    expect(promotedDespiteError(physical({}))).toBe(false);
    expect(
      promotedDespiteError(physical({ promoteIssuedAt: '2026-10-11T20:00Z' })),
    ).toBe(true);
  });
});
