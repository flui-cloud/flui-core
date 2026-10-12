import { DbMigrationStatus } from '../../db-lifecycle/enums/db-migration.enum';
import { AppMigrationStatus } from '../../app-migration/enums/app-migration.enum';
import { FullMigrationEntity } from '../entities/full-migration.entity';
import {
  FullCutoverMode,
  FullMigrationStatus,
  RESUMABLE_RUN_STATES,
} from '../enums/full-migration.enum';
import { FULL_MIGRATION_JOB_TYPES } from '../full-migration.constants';

export const FM_ACTIVE = [
  FullMigrationStatus.PENDING,
  FullMigrationStatus.DB_REPLICATING,
  FullMigrationStatus.APP_STAGING,
  FullMigrationStatus.READY,
  FullMigrationStatus.CUTOVER,
  FullMigrationStatus.BRIDGING,
];
export const DB_ACTIVE = [
  DbMigrationStatus.PENDING,
  DbMigrationStatus.PROVISIONING,
  DbMigrationStatus.REPLICATING,
  DbMigrationStatus.SYNCED,
  DbMigrationStatus.CUTOVER,
];
export const APP_ACTIVE = [
  AppMigrationStatus.PENDING,
  AppMigrationStatus.PROVISIONING,
  AppMigrationStatus.READY,
  AppMigrationStatus.CUTOVER,
  AppMigrationStatus.BRIDGING,
];

export const ABORTABLE = [
  FullMigrationStatus.PENDING,
  FullMigrationStatus.DB_REPLICATING,
  FullMigrationStatus.APP_STAGING,
  FullMigrationStatus.READY,
  FullMigrationStatus.FAILED,
];

export function canResumeCutover(
  fm: Pick<FullMigrationEntity, 'id' | 'status'>,
  live: Set<string> | undefined,
): boolean {
  if (fm.status === FullMigrationStatus.FAILED_FORWARD) return true;
  return (
    fm.status === FullMigrationStatus.CUTOVER && !!live && !live.has(fm.id)
  );
}

/** A migration left in this state at startup is driven by a job queued again. */
export function needsStartupResume(
  fm: Pick<FullMigrationEntity, 'status' | 'cutoverMode'>,
): boolean {
  return (
    fm.status === FullMigrationStatus.CUTOVER ||
    (RESUMABLE_RUN_STATES.includes(fm.status) &&
      (fm.status !== FullMigrationStatus.READY ||
        fm.cutoverMode === FullCutoverMode.AUTO))
  );
}

export function startupResumeJob(
  fm: Pick<FullMigrationEntity, 'id' | 'status' | 'updatedAt'>,
): { name: string; jobId: string } {
  const cutover = fm.status === FullMigrationStatus.CUTOVER;
  return {
    name: cutover
      ? FULL_MIGRATION_JOB_TYPES.RUN_FULL_CUTOVER
      : FULL_MIGRATION_JOB_TYPES.RUN_FULL_MIGRATION,
    jobId: `${cutover ? 'resume-cutover' : 'resume-run'}:${fm.id}:${fm.updatedAt?.getTime() ?? 0}`,
  };
}

export function jobMigrationIds(jobs: { data?: unknown }[]): Set<string> {
  return new Set(
    jobs
      .map(
        (j) => (j?.data as { migrationId?: string } | undefined)?.migrationId,
      )
      .filter((id): id is string => !!id),
  );
}
