import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import {
  RestoreJobStatus,
  RestoreTargetKind,
  RestoreStrategy,
} from '../enums/restore-job.enum';

export interface RestoreTargetSelector {
  namespaces?: string[];
  applicationId?: string;
  namespaceMapping?: Record<string, string>;
  labelSelector?: string;
  /** database PITR target: create a fresh catalog install to restore into. */
  newInstall?: { name: string; clusterId: string };
}

@Entity('restore_jobs')
@Index('idx_restore_jobs_user', ['userId'])
@Index('idx_restore_jobs_artifact', ['artifactId'])
@Index('idx_restore_jobs_status', ['status'])
export class RestoreJobEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  artifactId: string;

  @Column({ type: 'uuid' })
  sourceDestinationId: string;

  @Column({ type: 'uuid' })
  targetClusterId: string;

  @Column({ type: 'enum', enum: RestoreTargetKind })
  targetKind: RestoreTargetKind;

  @Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
  targetSelector: RestoreTargetSelector;

  @Column({
    type: 'enum',
    enum: RestoreStrategy,
    nullable: true,
  })
  strategy?: RestoreStrategy;

  /** For PG_PITR: recover to this instant; null = latest (end of WAL). */
  @Column({ type: 'timestamptz', nullable: true })
  recoveryTargetTime?: Date;

  @Column({ length: 253, nullable: true })
  veleroRestoreName?: string;

  @Column({
    type: 'enum',
    enum: RestoreJobStatus,
    default: RestoreJobStatus.PENDING,
  })
  status: RestoreJobStatus;

  @Column({ type: 'jsonb', nullable: true })
  previewResult?: Record<string, any>;

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
