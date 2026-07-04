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
