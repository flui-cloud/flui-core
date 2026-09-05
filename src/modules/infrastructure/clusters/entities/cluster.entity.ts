import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { ClusterNodeEntity } from './cluster-node.entity';
import { HostnameMode } from '../../../dns/enums/hostname-mode.enum';

export enum ClusterStatus {
  CREATING = 'creating',
  READY = 'ready',
  SCALING = 'scaling',
  STOPPED = 'stopped',
  ERROR = 'error',
  DELETING = 'deleting',
  DELETION_FAILED = 'deletion_failed',
  DELETED = 'deleted',
  /**
   * Unreachable and not coming back — the records of what ran on it are kept
   * so they can be re-materialised elsewhere.
   *
   * Distinct from DELETED, which somebody chose, and from ERROR, which may
   * still recover: a lost cluster must never be a deploy target again, and its
   * rows must never be mistaken for a live cluster's.
   */
  LOST = 'lost',
}

export enum ClusterType {
  CONTROL = 'control',
  WORKLOAD = 'workload',
  /** @deprecated legacy value for the control cluster; kept for back-compat reads until all rows are migrated. */
  OBSERVABILITY = 'observability',
}

/** Maps the legacy `observability` value forward to `control`; passes other values through. */
export function normalizeClusterType(
  value?: ClusterType | string | null,
): ClusterType {
  if (value === ClusterType.OBSERVABILITY) {
    return ClusterType.CONTROL;
  }
  return (value as ClusterType) ?? ClusterType.WORKLOAD;
}

/** True for the control cluster, accepting both the new and legacy enum values. */
export function isControlClusterType(
  value?: ClusterType | string | null,
): boolean {
  return value === ClusterType.CONTROL || value === ClusterType.OBSERVABILITY;
}

@Entity('infrastructure_clusters')
export class ClusterEntity {
  @PrimaryColumn('uuid')
  id: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }

  @Column()
  name: string;

  @Column()
  provider: string;

  @Column()
  region: string;

  @Column()
  nodeSize: string;

  @Column({ type: 'int', default: 0 })
  nodeCount: number;

  // Autoscaling
  @Column({ default: false })
  autoscalingEnabled: boolean;

  @Column({ type: 'int', nullable: true })
  minNodes?: number;

  @Column({ type: 'int', nullable: true })
  maxNodes?: number;

  @Column({ type: 'int', nullable: true })
  scaleUpMemoryPct?: number;

  @Column({ type: 'int', nullable: true })
  scaleUpCpuPct?: number;

  @Column({ type: 'int', nullable: true })
  cooldownSeconds?: number;

  // K3s specifics
  @Column({ type: 'text' })
  k3sTokenEncrypted: string; // Encrypted with EncryptionService

  @Column({ nullable: true })
  k3sVersion?: string;

  @Column({ nullable: true })
  masterNodeId?: string;

  @Column({ nullable: true })
  masterIpAddress?: string;

  @Column({ nullable: true })
  masterPrivateIp?: string;

  /**
   * Flui shared storage (NFS+fscache architecture, see APPLICATION_SCALING_AND_RESOURCE_MANAGEMENT.md §14).
   * When true, the master has an attached Volume that hosts the NFS export
   * for cluster-wide shared storage. Workers mount it via NFSv4 + fscache.
   * Default: true (controlled at creation by `flui env create --no-shared-storage`).
   */
  @Column({ type: 'boolean', default: true })
  sharedStorageEnabled: boolean;

  /**
   * Provider id of the Volume backing the NFS share, when sharedStorageEnabled
   * is true. Stored so it can be cleaned up at destroy time.
   */
  @Column({ type: 'varchar', nullable: true })
  sharedStorageVolumeId?: string | null;

  /** Size of the shared storage Volume in GB at creation time. */
  @Column({ type: 'int', nullable: true })
  sharedStorageVolumeSizeGb?: number | null;

  @Column({ type: 'text', nullable: true })
  kubeconfigEncrypted?: string; // Encrypted with EncryptionService

  // Status
  @Column({
    type: 'enum',
    enum: ClusterStatus,
    default: ClusterStatus.CREATING,
  })
  status: ClusterStatus;

  @Column({
    type: 'enum',
    enum: ClusterType,
    default: ClusterType.WORKLOAD,
  })
  clusterType: ClusterType;

  @Column({
    type: 'enum',
    enum: HostnameMode,
    default: HostnameMode.IP,
  })
  endpointHostnameMode: HostnameMode;

  @Column({ type: 'varchar', length: 30, nullable: true })
  nipHostnameToken?: string | null;

  @Column({ type: 'json', default: '{}' })
  metadata: Record<string, any>;

  @Column({ type: 'json', nullable: true })
  sshKeyIds?: string[];

  @Column({ nullable: true })
  image?: string;

  @Column({ type: 'int', nullable: true })
  diskSizeGb?: number;

  @Column({ nullable: true })
  bootstrapKeyId?: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;

  // Relations
  @OneToMany(() => ClusterNodeEntity, (node) => node.cluster, {
    cascade: true,
  })
  nodes: ClusterNodeEntity[];
}
