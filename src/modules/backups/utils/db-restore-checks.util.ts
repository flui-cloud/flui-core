import { ApplicationEntity } from '../../applications/entities/application.entity';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { BackupDestinationEntity } from '../entities/backup-destination.entity';
import { RestoreJobEntity } from '../entities/restore-job.entity';
import { ArtifactLocationState } from '../enums/artifact-location-state.enum';
import { DbRestorePlan, planDbRestore } from './db-restore-plan.util';

export interface DbRestoreContext {
  restoreJobId: string;
  restore: RestoreJobEntity;
  artifact: BackupArtifactEntity;
  sourceAppId: string;
  sourceApp: ApplicationEntity | null;
  dest: BackupDestinationEntity;
  newInstall: { name: string; clusterId: string };
  summary: Record<string, any>;
  requestedTarget: Date | null;
}

export function describeDbRestorePlan(plan: DbRestorePlan): string {
  return (
    `mode=${plan.mode}` +
    (plan.restoreSet ? ` set=${plan.restoreSet}` : '') +
    (plan.recoveryTargetTime
      ? ` target=${plan.recoveryTargetTime.toISOString()}`
      : '') +
    (plan.note ? ` (${plan.note})` : '')
  );
}

export function everythingArchivedPlan(
  artifactEngineRef: string | null,
  replaysToEndWithoutTarget: boolean,
): DbRestorePlan {
  return planDbRestore({
    requestedTarget: null,
    artifactEngineRef,
    artifactIsNewest: true,
    newestArchived: null,
    noChangesArchived: false,
    replaysToEndWithoutTarget,
    now: new Date(),
  });
}

export function assertArtifactStillStored(
  artifact: BackupArtifactEntity,
  destinationId: string,
): void {
  const primary =
    artifact.locations?.find((l) => l.destinationId === destinationId) ??
    artifact.locations?.[0];
  if (primary?.state === ArtifactLocationState.EXPIRED) {
    throw new Error(
      `Backup ${artifact.engineRef ?? artifact.id} no longer exists on its destination` +
        (primary.lastError ? ` (${primary.lastError})` : '') +
        '. Choose a newer backup.',
    );
  }
}

/**
 * A base is named only when it is restored as it stood. "Everything archived"
 * leaves the choice to the recovery, which takes the newest base — the one it
 * has to replay from anyway.
 */
export function assertTargetFitsArtifact(
  artifact: BackupArtifactEntity,
  requestedTarget: Date | null,
  pointInTime: boolean | undefined,
): void {
  if (requestedTarget && artifact.createdAt > requestedTarget) {
    throw new Error(
      `Backup ${artifact.engineRef ?? artifact.id} was taken at ` +
        `${artifact.createdAt.toISOString()}, after the ` +
        `${requestedTarget.toISOString()} asked for. Restoring it would ` +
        'return state from after that moment while reporting the moment. ' +
        'Choose a backup taken before it.',
    );
  }
  if (pointInTime === false && requestedTarget) {
    throw new Error(
      `This database is backed up by scheduled dumps, which restore the moment each was taken ` +
        `(${artifact.createdAt.toISOString()} for this one) and nothing in between. ` +
        'Restore it without a time, choosing the backup taken before the moment you need.',
    );
  }
}

export function parseNewestArchived(value?: string | null): Date | null {
  if (!value) return null;
  const at = new Date(value);
  return Number.isNaN(at.getTime()) ? null : at;
}

export function withoutPrefixedKeys(
  env: Record<string, string>,
  prefix: string,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(([k]) => !k.startsWith(prefix)),
  );
}

/**
 * `oldestRecoverable` is a timestamp for one engine and a base label for
 * another, so it is only compared when it parses as a moment. It silently did
 * not before: `Date.parse` on a MariaDB label gives NaN, every comparison
 * against it is false, and a refusal that can never fire reads exactly like
 * one that never had to. Returns false when the window is not an instant.
 */
export function assertTargetWithinWindow(
  target: Date,
  oldestRecoverable?: string | null,
): boolean {
  if (!oldestRecoverable) return true;
  const oldest = Date.parse(oldestRecoverable);
  if (Number.isNaN(oldest)) return false;
  if (target.getTime() < oldest) {
    throw new Error(
      `Recovery target ${target.toISOString()} precedes the oldest recoverable point ${oldestRecoverable}`,
    );
  }
  return true;
}

/**
 * Refuse when the catalog app cannot receive the restore switch.
 *
 * `resolveEnv` walks the env the manifest DECLARES and reads an override only
 * for those names — an override for an undeclared name is dropped without a
 * word. A restore whose environment is dropped does not fail: the image
 * initialises an empty data directory, the pod turns Ready, and the job
 * reports success over a database that contains nothing. That is the one
 * outcome this whole area exists to stop producing, so it is checked before
 * anything is installed rather than discovered afterwards.
 */
export function assertRestoreAwareManifest(
  definition: { manifest?: { spec?: unknown } } | null,
  engine: { engine: string; catalogSlug: string; restoreEnvPrefix: string },
  envNames: string[],
): void {
  if (!definition) {
    throw new Error(
      `Catalog app "${engine.catalogSlug}" is not published, so a ${engine.engine} backup cannot be restored into a new install`,
    );
  }
  const switchName = `${engine.restoreEnvPrefix}RESTORE`;
  const spec = definition.manifest?.spec as
    | { env?: Array<{ name: string }> }
    | undefined;
  if (!spec?.env?.some((e) => e.name === switchName)) {
    throw new Error(
      `The "${engine.catalogSlug}" catalog app does not declare ${switchName}, ` +
        'so the restore environment would be silently dropped and the new ' +
        'install would come up empty. Restoring this engine needs a catalog ' +
        'that boots it in restore mode.',
    );
  }
  // Same silent drop, one variable at a time: an encrypted backup restored
  // without its key variable fails deep inside the recovery instead of here.
  const declared = new Set(spec.env.map((e) => e.name));
  const undeclared = envNames.filter(
    (n) => n.startsWith(engine.restoreEnvPrefix) && !declared.has(n),
  );
  if (undeclared.length) {
    throw new Error(
      `The "${engine.catalogSlug}" catalog app does not declare ${undeclared.join(', ')}, ` +
        'which this restore needs. Update the catalog before restoring this backup.',
    );
  }
}
