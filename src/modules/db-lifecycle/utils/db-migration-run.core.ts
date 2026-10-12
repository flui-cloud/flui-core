import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ResourceOverridesDto } from '../../catalog/dto/resource-overrides.dto';
import { DbMigrationEntity } from '../entities/db-migration.entity';
import { DbReplicationLinkEntity } from '../entities/db-replication-link.entity';
import { PodPlacement } from '../services/db-pod-placement.service';
import { fenceAppliedAt, pauseMs } from './db-migration-view';
import { hasPoolerPlan } from './pooler-cut.core';

export const POSTGRESQL_SLUG = 'postgresql';
export const INSTALL_POLL_INTERVAL_MS = 5_000;
export const INSTALL_POLL_TIMEOUT_MS = 15 * 60 * 1000;
export const STREAMING_POLL_INTERVAL_MS = 5_000;
export const STREAMING_TIMEOUT_MS = 60 * 60 * 1000;
export const DRAIN_POLL_INTERVAL_MS = 1_000;
export const DRAIN_TIMEOUT_MS = 120 * 1000;
export const RESTORE_POLL_INTERVAL_MS = 10_000;
export const RESTORE_TIMEOUT_MS = 45 * 60 * 1000;
export const BASE_BACKUP_POLL_INTERVAL_MS = 5_000;
export const CUTOVER_RETRY_DELAY_MS = 30_000;
export const INSTALL_TIMED_OUT = /Timeout waiting for|did not complete within/i;

export function baseBackupTimeoutMs(): number {
  const raw = Number(process.env.FLUI_DB_BASE_BACKUP_TIMEOUT_MS);
  return Number.isInteger(raw) && raw > 0 ? raw : 6 * 60 * 60 * 1000;
}

export function resourcesOf(
  app: ApplicationEntity | null,
): ResourceOverridesDto | undefined {
  const cpu = app?.resources?.cpu;
  const memory = app?.resources?.memory;
  if (!cpu && !memory) return undefined;
  return {
    ...(cpu ? { cpu: { request: cpu.request, limit: cpu.limit } } : {}),
    ...(memory
      ? { memory: { request: memory.request, limit: memory.limit } }
      : {}),
  } as ResourceOverridesDto;
}

export function assertSameNodes(
  link: Pick<DbReplicationLinkEntity, 'srcNodeId' | 'dstNodeId'>,
  src: Pick<PodPlacement, 'nodeId'>,
  dst: Pick<PodPlacement, 'nodeId'>,
): void {
  if (link.srcNodeId !== src.nodeId || link.dstNodeId !== dst.nodeId) {
    throw new Error(
      'A Postgres pod moved to another node since the link was built; abort and start the migration again',
    );
  }
}

export function pooledCut<T>(
  service: T | undefined,
  mig: Pick<DbMigrationEntity, 'poolerCut'>,
): T | null {
  return service && hasPoolerPlan(mig.poolerCut) ? service : null;
}

export function promoteMeasures(
  mig: Pick<DbMigrationEntity, 'poolerCut' | 'fence'>,
  now: Date,
): {
  writesStoppedAt: Date | null;
  promoteConfirmedAt: Date;
  writePauseMs: number | null;
} {
  const pausedAt = mig.poolerCut?.pausedAt
    ? new Date(mig.poolerCut.pausedAt)
    : null;
  const measures = {
    writesStoppedAt: pausedAt ?? fenceAppliedAt(mig.fence),
    promoteConfirmedAt: now,
  };
  const writePauseMs = pauseMs(
    measures.writesStoppedAt,
    measures.promoteConfirmedAt,
  );
  return { ...measures, writePauseMs };
}
