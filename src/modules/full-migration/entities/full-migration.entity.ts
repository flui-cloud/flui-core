import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import {
  FullMigrationStatus,
  FullCutoverMode,
  FullStagingMode,
} from '../enums/full-migration.enum';
import { RewirePlan } from '../services/db-connection-rewire.service';

/**
 * One run of the full-app migration orchestrator (plan §6 / MVP-5c): move a
 * live app AND its managed Postgres to another cluster, rewiring the app's DB
 * connection. Parent of a DbMigration leg + an AppMigration leg, both driven
 * in MANUAL cutover mode and joined by the coordinated cutover.
 */
@Entity('full_migrations')
@Index('idx_full_migrations_app', ['appId'])
export class FullMigrationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  /** The consumer application being moved. */
  @Column({ type: 'uuid' })
  appId: string;

  /** The source managed-Postgres application whose data migrates. */
  @Column({ type: 'uuid' })
  dbAppId: string;

  @Column({ type: 'uuid' })
  targetClusterId: string;

  @Column({
    type: 'enum',
    enum: FullCutoverMode,
    default: FullCutoverMode.AUTO,
  })
  cutoverMode: FullCutoverMode;

  @Column({
    type: 'enum',
    enum: FullStagingMode,
    default: FullStagingMode.SCALED_DOWN,
  })
  stagingMode: FullStagingMode;

  @Column({
    type: 'enum',
    enum: FullMigrationStatus,
    default: FullMigrationStatus.PENDING,
  })
  status: FullMigrationStatus;

  @Column({ type: 'uuid', nullable: true })
  dbMigrationId?: string;

  @Column({ type: 'uuid', nullable: true })
  appMigrationId?: string;

  /** Full rewire plan (env already single-encrypted), computed pre-fence and reused on resume. */
  @Column({ type: 'jsonb', nullable: true })
  rewirePlan?: RewirePlan;

  @Column({ type: 'uuid', nullable: true })
  infrastructureOperationId?: string;

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
