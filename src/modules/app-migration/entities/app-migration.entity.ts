import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import {
  AppMigrationStatus,
  AppCutoverMode,
} from '../enums/app-migration.enum';
import { MaterializeOverrides } from '../../applications/services/application-materializer.service';

/**
 * One run of the application migration machine (plan §6 step 2): move a live
 * app's workload to another cluster from stored state. The app keeps its
 * identity (same app id / slug / FQDN), so there is no destination app row —
 * the source app is re-bound to `targetClusterId` at cutover. `srcClusterId`
 * is captured at create time so DESTROY knows where the drained source lives.
 */
@Entity('app_migrations')
@Index('idx_app_migrations_src', ['srcAppId'])
export class AppMigrationEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  srcAppId: string;

  @Column({ type: 'uuid' })
  srcClusterId: string;

  @Column({ type: 'uuid' })
  targetClusterId: string;

  @Column({ type: 'enum', enum: AppCutoverMode, default: AppCutoverMode.AUTO })
  cutoverMode: AppCutoverMode;

  @Column({
    type: 'enum',
    enum: AppMigrationStatus,
    default: AppMigrationStatus.PENDING,
  })
  status: AppMigrationStatus;

  /** Non-persisted materialize overrides (e.g. replicas:0 staging by an orchestrator). */
  @Column({ type: 'jsonb', nullable: true })
  provisionOverrides?: MaterializeOverrides;

  /** Set when this migration is a child leg of a full-app orchestration. */
  @Column({ type: 'uuid', nullable: true })
  fullMigrationId?: string;

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
