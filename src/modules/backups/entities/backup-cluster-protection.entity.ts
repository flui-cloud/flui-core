import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type ProtectedAppOutcomeKind =
  | 'protected'
  | 'already_protected'
  | 'waiting'
  | 'needs_decision'
  | 'failed'
  | 'skipped';

/** What the last pass over one application decided, and why. */
export interface ProtectedAppOutcome {
  outcome: ProtectedAppOutcomeKind;
  reason?: string;
  policyId?: string;
  engine?: string;
  engineClass?: string;
  at: string;
}

/**
 * "Protect this cluster": every application on it gets a backup policy of its
 * own, including the ones installed later. The row is the promise; the
 * policies it created are ordinary policies and outlive it.
 */
@Entity('backup_cluster_protections')
@Index('uq_backup_cluster_protections_cluster', ['clusterId'], {
  unique: true,
})
export class BackupClusterProtectionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid' })
  clusterId: string;

  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  destinationId: string;

  @Column({ type: 'uuid', nullable: true })
  replicaDestinationId?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  cronSchedule?: string | null;

  @Column({ type: 'int', default: 30 })
  retentionDays: number;

  @Column({ type: 'boolean', default: false })
  beforeDeploy: boolean;

  @Column({ type: 'jsonb', default: {} })
  applications: Record<string, ProtectedAppOutcome>;

  @Column({ type: 'timestamptz', nullable: true })
  lastReconciledAt?: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
