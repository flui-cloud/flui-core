import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { BackupScope } from '../enums/backup-scope.enum';
import {
  BackupPolicyStatus,
  BackupPolicyProfile,
} from '../enums/backup-policy-status.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupPolicyDestinationEntity } from './backup-policy-destination.entity';

export interface BackupScopeSelector {
  namespaces?: string[];
  applicationIds?: string[];
  labelSelector?: string;
}

@Entity('backup_policies')
@Index('idx_backup_policies_cluster', ['clusterId'])
@Index('idx_backup_policies_user', ['userId'])
@Index('idx_backup_policies_enabled_next', ['enabled', 'nextRunAt'])
export class BackupPolicyEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  clusterId: string;

  @ManyToOne(() => ClusterEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'clusterId' })
  cluster: ClusterEntity;

  @Column({ length: 120 })
  name: string;

  @Column({ type: 'enum', enum: BackupScope })
  scope: BackupScope;

  @Column({
    type: 'enum',
    enum: BackupEngineClass,
    default: BackupEngineClass.VOLUME,
  })
  engineClass: BackupEngineClass;

  @Column({ type: 'jsonb', default: {} })
  scopeSelector: BackupScopeSelector;

  @Column({ default: true })
  includePvcs: boolean;

  @Column({ default: false })
  includeEtcdL1: boolean;

  @Column({ length: 64, nullable: true })
  cronSchedule?: string;

  @Column({ type: 'int', default: 30 })
  retentionDays: number;

  @Column({ type: 'int', nullable: true })
  retentionMaxCopies?: number;

  @Column({ default: true })
  enabled: boolean;

  @Column({
    type: 'enum',
    enum: BackupPolicyStatus,
    default: BackupPolicyStatus.ACTIVE,
  })
  status: BackupPolicyStatus;

  @Column({
    type: 'enum',
    enum: BackupPolicyProfile,
    default: BackupPolicyProfile.SINGLE,
  })
  profile: BackupPolicyProfile;

  @Column({ type: 'timestamptz', nullable: true })
  lastRunAt?: Date;

  @Column({ type: 'timestamptz', nullable: true })
  nextRunAt?: Date;

  /**
   * Resolved once at creation from the catalog's declared engine, and never
   * re-derived: a disaster restore runs when the application is gone, so the
   * policy has to remember what it was protecting.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  engine?: string;

  @Column({ type: 'jsonb', default: {} })
  metadata: Record<string, any>;

  @OneToMany(() => BackupPolicyDestinationEntity, (pd) => pd.policy, {
    cascade: true,
    eager: true,
  })
  destinations: BackupPolicyDestinationEntity[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
