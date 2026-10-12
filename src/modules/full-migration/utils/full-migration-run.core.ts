import { DbMigrationEntity } from '../../db-lifecycle/entities/db-migration.entity';
import { DbReplicationKind } from '../../db-lifecycle/enums/db-replication-status.enum';
import { DbMigrationStatus } from '../../db-lifecycle/enums/db-migration.enum';

const DB_REPLICATE_TIMEOUT_MS = 75 * 60 * 1000;

export function dbReplicateTimeoutMs(dbChild: DbMigrationEntity): number {
  if (dbChild.kind !== DbReplicationKind.PHYSICAL)
    return DB_REPLICATE_TIMEOUT_MS;
  const raw = Number(process.env.FLUI_DB_BASE_BACKUP_TIMEOUT_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : 6 * 60 * 60 * 1000;
}

export const isPhysical = (c?: DbMigrationEntity | null): boolean =>
  c?.kind === DbReplicationKind.PHYSICAL;
export const APP_STAGE_TIMEOUT_MS = 15 * 60 * 1000;
export const CHILD_CUTOVER_TIMEOUT_MS = 12 * 60 * 1000;
/** The write pause lasts until the promote is seen: poll it fast. */
export const PROMOTE_POLL_MS = 1_000;
export const BRIDGE_OPEN_TIMEOUT_MS = 10 * 60 * 1000;

/** Ground truth after a failed promote wait: did the child promote despite our error? */
export function promotedDespiteError(c: DbMigrationEntity | null): boolean {
  return (
    !!c &&
    (c.status === DbMigrationStatus.COMPLETED ||
      (c.status === DbMigrationStatus.CUTOVER &&
        (!isPhysical(c) || !!c.fence?.promoteIssuedAt)))
  );
}
