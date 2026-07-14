import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';
import {
  BackupJobStatus,
  BackupJobTriggerType,
} from '../enums/backup-job.enum';

@Entity('backup_jobs')
@Index('idx_backup_jobs_policy_created', ['policyId', 'createdAt'])
@Index('idx_backup_jobs_cluster_status', ['clusterId', 'status'])
@Index('idx_backup_jobs_trigger_status', ['triggerType', 'status'])
export class BackupJobEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true })
  policyId?: string;

  @Column({ type: 'uuid' })
  clusterId: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'enum', enum: BackupJobTriggerType })
  triggerType: BackupJobTriggerType;

  @Column({ type: 'jsonb', default: {} })
  triggerContext: Record<string, any>;

  @Column({ length: 253, nullable: true })
  veleroBackupName?: string;

  @Column({
    type: 'enum',
    enum: BackupJobStatus,
    default: BackupJobStatus.PENDING,
  })
  status: BackupJobStatus;

  @Column({ type: 'jsonb', default: {} })
  scopeSnapshot: Record<string, any>;

  @Column({ type: 'timestamptz', nullable: true })
  startedAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  finishedAt?: Date;

  @Column({ type: 'uuid', nullable: true })
  infrastructureOperationId?: string;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, any>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
