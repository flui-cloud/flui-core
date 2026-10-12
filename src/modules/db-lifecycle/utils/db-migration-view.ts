import {
  DbFenceRecord,
  DbMigrationEntity,
  DbPoolerCutRecord,
  PoolerResumedBy,
} from '../entities/db-migration.entity';
import { DbReplicationLinkEntity } from '../entities/db-replication-link.entity';
import { DbMigrationStatus } from '../enums/db-migration.enum';
import {
  DbReplicationKind,
  DbReplicationStatus,
} from '../enums/db-replication-status.enum';
import {
  WireGuardLinkEntity,
  WireGuardLinkState,
} from '../../infrastructure/networking/entities/wireguard-link.entity';

export interface MigrationNextStep {
  key: 'protect-database' | 'repoint-consumers' | 'destroy-source';
  text: string;
}

export interface DbFenceView {
  appliedAt: string | null;
  fenceLsn: string | null;
  terminatedSessions: number | null;
  promoteIssuedAt: string | null;
  released: boolean;
  releasedAt: string | null;
  releaseNote: string | null;
}

export interface DbLinkView {
  state: WireGuardLinkState;
  listenerNode: string | null;
  dialerNode: string | null;
  handshakeSeen: boolean;
  lastHandshakeAt: string | null;
  openedAt: string | null;
  closedAt: string | null;
}

export type BaseBackupPhase =
  | 'waiting'
  | 'copying'
  | 'done'
  | 'failed'
  | 'aborted';

export interface DbBaseBackupView {
  phase: BaseBackupPhase;
  /** WAL the standby still has to replay, once it streams. */
  lagBytes: number | null;
}

export interface DbSourceWalCapView {
  value: string;
  note: string | null;
}

/** The poolers' wait around the cutover, and who was cut at the deadline. */
export interface DbPoolerCutView {
  paused: boolean;
  pausedAt: string | null;
  resumedAt: string | null;
  resumedBy: PoolerResumedBy | null;
  /** The source's pooler stays paused for good once the destination took over. */
  sourceLeftPaused: boolean;
  deadlineMs: number;
  cut: Array<{ clientApp: string | null; heldMs: number | null }>;
}

export type DbMigrationView = Omit<DbMigrationEntity, 'fence' | 'poolerCut'> & {
  fence: DbFenceView | null;
  pooler: DbPoolerCutView | null;
  link: DbLinkView | null;
  baseBackup: DbBaseBackupView | null;
  sourceWalCap: DbSourceWalCapView | null;
  nextSteps: MigrationNextStep[];
};

type Moment = Date | string | null;

function instant(value?: Moment): number | null {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Null when either end is unknown, or the end does not follow the start. */
export function pauseMs(start?: Moment, end?: Moment): number | null {
  const from = instant(start);
  const to = instant(end);
  if (from === null || to === null || to < from) return null;
  return to - from;
}

/** The fence's start, read back as a date; a malformed record gives none. */
export function fenceAppliedAt(fence?: DbFenceRecord | null): Date | null {
  const t = instant(fence?.appliedAt);
  return t === null ? null : new Date(t);
}

export function fenceView(fence?: DbFenceRecord | null): DbFenceView | null {
  if (!fence) return null;
  return {
    appliedAt: fence.appliedAt ?? null,
    fenceLsn: fence.fenceLsn ?? null,
    terminatedSessions: fence.terminatedSessions ?? null,
    promoteIssuedAt: fence.promoteIssuedAt ?? null,
    released: !!fence.releasedAt,
    releasedAt: fence.releasedAt ?? null,
    releaseNote: fence.releaseNote ?? null,
  };
}

export function poolerCutView(
  cut?: DbPoolerCutRecord | null,
): DbPoolerCutView | null {
  if (!cut?.poolers?.length) return null;
  return {
    paused: !!cut.pausedAt && !cut.resumedAt,
    pausedAt: cut.pausedAt ?? null,
    resumedAt: cut.resumedAt ?? null,
    resumedBy: cut.resumedBy ?? null,
    sourceLeftPaused: !!cut.sourceLeftPaused,
    deadlineMs: cut.deadlineMs,
    cut: (cut.cut ?? []).map((c) => ({
      clientApp: c.clientApp,
      heldMs: c.heldMs,
    })),
  };
}

export function linkView(
  link: WireGuardLinkEntity | null | undefined,
  nodeNames: Map<string, string>,
): DbLinkView | null {
  if (!link) return null;
  const iso = (d?: Date | null) => (d ? new Date(d).toISOString() : null);
  return {
    state: link.state,
    listenerNode: nodeNames.get(link.listenerNodeId) ?? null,
    dialerNode: nodeNames.get(link.dialerNodeId) ?? null,
    handshakeSeen: !!link.lastHandshakeAt,
    lastHandshakeAt: iso(link.lastHandshakeAt),
    openedAt: iso(link.openedAt),
    closedAt: iso(link.closedAt),
  };
}

const PHASE: Record<DbReplicationStatus, BaseBackupPhase> = {
  [DbReplicationStatus.INIT]: 'waiting',
  [DbReplicationStatus.COPYING]: 'copying',
  [DbReplicationStatus.STREAMING]: 'done',
  [DbReplicationStatus.PROMOTED]: 'done',
  [DbReplicationStatus.FAILED]: 'failed',
  [DbReplicationStatus.ABORTED]: 'aborted',
};

export function baseBackupView(
  repl: DbReplicationLinkEntity | null | undefined,
): DbBaseBackupView | null {
  if (!repl) return null;
  const lag = repl.lagBytes == null ? null : Number(repl.lagBytes);
  return {
    phase: PHASE[repl.status] ?? 'waiting',
    lagBytes:
      repl.status === DbReplicationStatus.STREAMING && Number.isFinite(lag)
        ? lag
        : null,
  };
}

export function protectDatabaseStep(
  dstAppId?: string | null,
): MigrationNextStep {
  const which = dstAppId ? ` (${dstAppId})` : '';
  return {
    key: 'protect-database',
    text: `Protect the new database${which} with a backup policy: the migration does not create one.`,
  };
}

export function dbNextSteps(mig: DbMigrationEntity): MigrationNextStep[] {
  if (mig.status !== DbMigrationStatus.COMPLETED) return [];
  const steps = [protectDatabaseStep(mig.dstAppId)];
  if (!mig.fullMigrationId) {
    steps.push({
      key: 'repoint-consumers',
      text: 'Point the applications that used the source database at the new one: this migration does not repoint them.',
    });
  }
  return steps;
}

// The cap is reset once the migration ends, so it is only news while it runs.
const WAL_CAP_RELEASED = new Set<string>([
  DbMigrationStatus.COMPLETED,
  DbMigrationStatus.ABORTED,
  DbMigrationStatus.FAILED,
]);

export function dbMigrationView(
  mig: DbMigrationEntity,
  parts: {
    repl?: DbReplicationLinkEntity | null;
    wg?: WireGuardLinkEntity | null;
    nodeNames?: Map<string, string>;
  } = {},
): DbMigrationView {
  const { fence, poolerCut, ...rest } = mig;
  return {
    ...rest,
    fence: fenceView(fence),
    pooler: poolerCutView(poolerCut),
    link: linkView(parts.wg, parts.nodeNames ?? new Map()),
    baseBackup:
      mig.kind === DbReplicationKind.PHYSICAL
        ? baseBackupView(parts.repl)
        : null,
    sourceWalCap:
      parts.repl?.transport?.walKeepSet && !WAL_CAP_RELEASED.has(mig.status)
        ? {
            value: parts.repl.transport.walKeepSet,
            note: parts.repl.transport.walKeepNote ?? null,
          }
        : null,
    nextSteps: dbNextSteps(mig),
  };
}
