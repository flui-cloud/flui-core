import { AppMigrationEntity } from '../../app-migration/entities/app-migration.entity';
import { DbMigrationEntity } from '../../db-lifecycle/entities/db-migration.entity';
import { DbReplicationKind } from '../../db-lifecycle/enums/db-replication-status.enum';
import {
  DbBaseBackupView,
  DbFenceView,
  DbLinkView,
  DbMigrationView,
  DbPoolerCutView,
  MigrationNextStep,
  fenceAppliedAt,
  pauseMs,
  protectDatabaseStep,
} from '../../db-lifecycle/utils/db-migration-view';
import { WritePauseEndedBy } from '../entities/full-migration.entity';
import { FullMigrationStatus } from '../enums/full-migration.enum';
import type { FullMigrationView } from '../services/full-migration.service';

export interface FullWritePause {
  writePauseMs: number | null;
  writePauseEndedBy: WritePauseEndedBy | null;
}

export type FullMigrationReadView = FullMigrationView & {
  kind: DbReplicationKind | null;
  link: DbLinkView | null;
  fence: DbFenceView | null;
  pooler: DbPoolerCutView | null;
  baseBackup: DbBaseBackupView | null;
  interruptionMs: number | null;
  nextSteps: MigrationNextStep[];
};

/**
 * From the database fence to the moment clients' writes reach the destination:
 * the destination pooler's resume when both poolers held the writes, the promote when the bridge already forwarded before the fence, the bridge's
 * activation when it opened after, otherwise the DNS switch.
 */
export function fullWritePause(
  dbLeg:
    | (Pick<
        DbMigrationEntity,
        'writesStoppedAt' | 'fence' | 'promoteConfirmedAt'
      > &
        Partial<Pick<DbMigrationEntity, 'poolerCut'>>)
    | null,
  appLeg: Pick<AppMigrationEntity, 'bridgeState' | 'dnsFlippedAt'> | null,
): FullWritePause {
  const none: FullWritePause = { writePauseMs: null, writePauseEndedBy: null };
  if (!dbLeg || !appLeg) return none;
  // Pooled: writes waited in the poolers from the pause to the resume.
  const pooled = pauseMs(dbLeg.poolerCut?.pausedAt, dbLeg.poolerCut?.resumedAt);
  if (pooled !== null) {
    return { writePauseMs: pooled, writePauseEndedBy: 'resume' };
  }
  const start = dbLeg.writesStoppedAt ?? fenceAppliedAt(dbLeg.fence);
  const bridge = appLeg.bridgeState;
  const activated =
    bridge?.mode === 'bridge' ? (bridge.activatedAt ?? null) : null;
  const beforeFence = !!activated && pauseMs(activated, start) !== null;
  let end: Date | string | null | undefined;
  let endedBy: WritePauseEndedBy;
  if (beforeFence) {
    end = dbLeg.promoteConfirmedAt;
    endedBy = 'promote';
  } else if (activated) {
    end = activated;
    endedBy = 'bridge';
  } else {
    end = appLeg.dnsFlippedAt;
    endedBy = 'dns';
  }
  // With the bridge open first, writes stop when traffic reaches the
  // read-only standby, before the fence lands on the source.
  const ms = pauseMs(beforeFence ? activated : start, end);
  return ms === null ? none : { writePauseMs: ms, writePauseEndedBy: endedBy };
}

export function fullNextSteps(
  fm: Pick<FullMigrationView, 'status'>,
  dbLeg: Pick<DbMigrationEntity, 'dstAppId'> | null,
  appLeg: Pick<AppMigrationEntity, 'sourceDestroyedAt'> | null,
): MigrationNextStep[] {
  if (fm.status !== FullMigrationStatus.COMPLETED) return [];
  const steps = [protectDatabaseStep(dbLeg?.dstAppId)];
  if (appLeg && !appLeg.sourceDestroyedAt) {
    steps.push({
      key: 'destroy-source',
      text: 'Destroy the source application workload once you no longer need it; the source database stays fenced and is not removed.',
    });
  }
  return steps;
}

export function fullMigrationReadView(
  fm: FullMigrationView,
  dbLeg: DbMigrationView | null,
  appLeg: AppMigrationEntity | null,
): FullMigrationReadView {
  return {
    ...fm,
    kind: dbLeg?.kind ?? null,
    link: dbLeg?.link ?? null,
    fence: dbLeg?.fence ?? null,
    pooler: dbLeg?.pooler ?? null,
    baseBackup: dbLeg?.baseBackup ?? null,
    writePauseMs: fm.writePauseMs ?? null,
    writePauseEndedBy: fm.writePauseEndedBy ?? null,
    interruptionMs: appLeg?.interruptionMs ?? null,
    nextSteps: fullNextSteps(fm, dbLeg, appLeg),
  };
}
