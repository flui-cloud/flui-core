import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import {
  DbMigrationStatus,
  DbMigrationMode,
  DbCutoverMode,
} from '../enums/db-migration.enum';
import { DbReplicationKind } from '../enums/db-replication-status.enum';

/** The hard write fence on the source, recorded so an abort undoes it exactly. */
export interface DbFenceRecord {
  method: 'pg_hba';
  marker: string;
  hbaSha256Before: string;
  appliedAt: string;
  terminatedSessions?: number;
  fenceLsn?: string;
  /** Set right before `pg_promote` is asked: from here the destination may be primary. */
  promoteIssuedAt?: string;
  releasedAt?: string | null;
  releaseNote?: string | null;
}

export type PoolerCutRole = 'source' | 'destination';
export type PoolerResumedBy = 'rollback' | 'abort' | 'retarget';

/** A pooled session still holding a server connection when the pause deadline came. */
export interface DbPoolerCutEntry {
  pod: string;
  role: PoolerCutRole;
  remotePid: number | null;
  clientId: number | null;
  user: string;
  database: string;
  clientAddr: string | null;
  clientApp: string | null;
  heldMs: number | null;
}

/**
 * The poolers paused around the cutover, written by the full migration before
 * it asks for the cutover. Without `poolers` the cutover is the plain one.
 */
export interface DbPoolerCutRecord {
  poolers: Array<{ appId: string; role: PoolerCutRole }>;
  deadlineMs: number;
  budgetMs?: number;
  /** The source as the forward probe saw it; the promoted destination is on the next timeline. */
  sourceSystemIdentifier?: string | null;
  sourceTimeline?: number | null;
  /** Pods a `PAUSE` was started on, so every way out resumes exactly those. */
  pausedPods?: Array<{ appId: string; pod: string }>;
  pausedAt?: string | null;
  drainedAt?: string | null;
  cut?: DbPoolerCutEntry[];
  fencedAt?: string | null;
  retargetedAt?: string | null;
  resumedAt?: string | null;
  resumedBy?: PoolerResumedBy | null;
  sourceLeftPaused?: boolean;
  notes?: string[];
}

/**
 * One run of the database migration machine (plan §6, inner core): move a
 * managed Postgres to another cluster, live (replication + fenced cutover) or
 * from backup (DR). Records the src→dst app mapping consumers will need.
 */
@Entity('db_migrations')
@Index('idx_db_migrations_src', ['srcAppId'])
export class DbMigrationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  srcAppId: string;

  @Column({ type: 'uuid' })
  targetClusterId: string;

  @Column({ length: 120 })
  displayName: string;

  @Column({
    type: 'enum',
    enum: DbMigrationMode,
    default: DbMigrationMode.LIVE,
  })
  mode: DbMigrationMode;

  @Column({ type: 'enum', enum: DbCutoverMode, default: DbCutoverMode.AUTO })
  cutoverMode: DbCutoverMode;

  @Column({
    type: 'varchar',
    length: 16,
    default: DbReplicationKind.LOGICAL,
  })
  kind: DbReplicationKind;

  @Column({ type: 'boolean', default: true })
  verifyRowCounts: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  recoveryTargetTime?: Date;

  @Column({
    type: 'enum',
    enum: DbMigrationStatus,
    default: DbMigrationStatus.PENDING,
  })
  status: DbMigrationStatus;

  @Column({ type: 'uuid', nullable: true })
  dstInstallId?: string;

  @Column({ type: 'uuid', nullable: true })
  dstAppId?: string;

  @Column({ type: 'uuid', nullable: true })
  linkId?: string;

  @Column({ type: 'uuid', nullable: true })
  restoreJobId?: string;

  @Column({ type: 'uuid', nullable: true })
  infrastructureOperationId?: string;

  /** Set when this migration is a child leg of a full-app orchestration. */
  @Column({ type: 'uuid', nullable: true })
  fullMigrationId?: string;

  @Column({ type: 'jsonb', nullable: true })
  fence?: DbFenceRecord | null;

  /** When writes stopped on the source: the fence was applied. */
  @Column({ type: 'timestamptz', nullable: true })
  writesStoppedAt?: Date | null;

  /** When the destination was confirmed to accept writes. */
  @Column({ type: 'timestamptz', nullable: true })
  promoteConfirmedAt?: Date | null;

  @Column({ type: 'int', nullable: true })
  writePauseMs?: number | null;

  @Column({ type: 'jsonb', nullable: true })
  poolerCut?: DbPoolerCutRecord | null;

  @Column({ type: 'jsonb', nullable: true })
  verifySummary?: { tables: number; mismatches: string[] };

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt?: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
