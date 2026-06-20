import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
  ManyToOne,
  JoinColumn,
  BeforeInsert,
} from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { AppRevisionEntity } from './app-revision.entity';
import { AppResourceEntity } from './app-resource.entity';
import { ApplicationCategory } from '../enums/application-category.enum';
import { ApplicationKind } from '../enums/application-kind.enum';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { ApplicationStatus } from '../enums/application-status.enum';
import { ApplicationExposure } from '../enums/application-exposure.enum';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';
import {
  ApplicationSourceConfig,
  ApplicationEnvVar,
  ApplicationResources,
  ApplicationScaling,
  ApplicationSecurityContext,
  ApplicationHealthProbe,
  ApplicationVolume,
} from '../interfaces/source-config.interface';

@Entity('applications')
export class ApplicationEntity {
  @PrimaryColumn('uuid')
  id: string;

  @BeforeInsert()
  generateId() {
    if (!this.id) {
      this.id = uuidv4();
    }
  }

  @Column({ length: 255 })
  name: string;

  @Column({ length: 255, unique: true })
  slug: string;

  @Column({ type: 'text', nullable: true })
  description?: string;

  @Column({
    type: 'enum',
    enum: ApplicationCategory,
  })
  category: ApplicationCategory;

  @Column({
    type: 'enum',
    enum: ApplicationKind,
    default: ApplicationKind.APPLICATION,
  })
  kind: ApplicationKind;

  @Column({
    type: 'enum',
    enum: ApplicationSourceType,
  })
  sourceType: ApplicationSourceType;

  @Column('uuid')
  clusterId: string;

  @ManyToOne(() => ClusterEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'clusterId' })
  cluster: ClusterEntity;

  @Column({ length: 100, default: 'default' })
  k8sNamespace: string;

  @Column({
    type: 'enum',
    enum: ApplicationStatus,
    default: ApplicationStatus.PENDING,
  })
  status: ApplicationStatus;

  @Column({
    type: 'enum',
    enum: ReconciliationStatus,
    default: ReconciliationStatus.PENDING,
  })
  reconciliationStatus: ReconciliationStatus;

  @Column({ type: 'timestamptz', nullable: true })
  lastReconciliationAt?: Date;

  @Column({ type: 'text', nullable: true })
  reconciliationError?: string;

  @Column({ type: 'json', default: '{}' })
  sourceConfig: ApplicationSourceConfig;

  @Column({ type: 'json', default: '[]' })
  env: ApplicationEnvVar[];

  @Column({ type: 'json', default: '{}' })
  resources: ApplicationResources;

  @Column({ type: 'json', default: '{}' })
  scaling: ApplicationScaling;

  @Column({ type: 'json', nullable: true })
  healthProbe?: ApplicationHealthProbe;

  @Column({ type: 'json', default: '[]' })
  volumes: ApplicationVolume[];

  @Column({
    type: 'varchar',
    length: 20,
    default: 'Deployment',
  })
  workloadKind: 'Deployment' | 'StatefulSet' | 'DaemonSet';

  @Column({ type: 'int', default: 1 })
  replicas: number;

  @Column({ type: 'int', nullable: true })
  port?: number;

  @Column({ type: 'varchar', length: 8, nullable: true })
  portProtocol?: 'http' | 'tcp';

  @Column({ type: 'json', nullable: true })
  configFiles?: Array<{ path: string; content: string }>;

  @Column({ type: 'uuid', nullable: true })
  currentRevisionId?: string;

  @Column({ length: 255, nullable: true })
  imageRef?: string;

  @Column({ type: 'text', nullable: true })
  startCommand?: string;

  // Exec-form entrypoint override (full argv, run without a shell). Takes
  // precedence over startCommand. Required for distroless images that have no
  // /bin/sh (e.g. Garage): startCommand wraps in ["/bin/sh","-c"] which fails.
  @Column({ type: 'json', nullable: true })
  command?: string[];

  @Column({ type: 'json', nullable: true })
  securityContext?: ApplicationSecurityContext;

  @Column({ nullable: true })
  userId?: string;

  @Column({ default: false })
  systemProtected: boolean;

  @Column({ default: false })
  autoDeploy: boolean;

  /**
   * Controls how the app is reached. `public` generates Ingress + Certificate
   * + DNS on a public hostname. `internal` skips all public exposure: only
   * Deployment + Service ClusterIP are created; the app is reachable only
   * from the Flui dashboard via the ForwardAuth proxy.
   */
  @Column({
    type: 'enum',
    enum: ApplicationExposure,
    default: ApplicationExposure.PUBLIC,
  })
  exposure: ApplicationExposure;

  @Column({ type: 'json', default: '{}' })
  labels: Record<string, string>;

  @Column({ type: 'json', default: '{}' })
  metadata: Record<string, string>;

  @Column({ type: 'boolean', default: false })
  preDeploySnapshotEnabled: boolean;

  @Column({ type: 'varchar', length: 32, default: 'best_effort' })
  preDeploySnapshotPolicy: 'required' | 'best_effort';

  @Column({ type: 'json', default: '{"maxCopies":5,"days":7}' })
  preDeployRetention: { maxCopies: number; days: number };

  @Column({ type: 'timestamptz', nullable: true })
  lastDeployedAt?: Date;

  /** GitHub Actions V2 build path fields */
  @Column({ type: 'varchar', length: 50, nullable: true })
  buildPath?: 'github-actions' | 'railpack' | 'dockerfile' | 'image';

  @Column({ type: 'text', nullable: true })
  workflowRunId?: string;

  /**
   * Fully-qualified HTML URL of the workflow run on GitHub, cached at commit
   * time so the frontend can link to it without re-resolving owner/repo.
   * Populated in generateAndCommitWorkflow[V3] once the run is visible.
   */
  @Column({ type: 'text', nullable: true })
  workflowRunUrl?: string;

  /**
   * Timestamp at which the app entered AWAITING_BUILD. Used by the background
   * build watcher to enforce a timeout: if we stay in AWAITING_BUILD past
   * this timestamp + BUILD_TIMEOUT_MS, we transition to FAILED with a clear
   * error instead of lingering forever.
   */
  @Column({ type: 'timestamptz', nullable: true })
  buildStartedAt?: Date;

  /**
   * Snapshot of the GitHub Actions workflow run status from the last watcher
   * tick (or from /workflow-status polls). Cached so that GET /applications/:id
   * can return up-to-date build info without hitting the GitHub API.
   * Values mirror {@link WorkflowRunStatus.status}: queued | in_progress | completed
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  lastBuildStatus?: string;

  /**
   * Cached conclusion of the last completed workflow run. Null while the
   * build is still queued or in progress. Values mirror
   * {@link WorkflowRunStatus.conclusion}: success | failure | cancelled | null
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  lastBuildConclusion?: string;

  @Column({ type: 'text', nullable: true })
  webhookToken?: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  frameworkConfirmed?: string;

  @Column({ default: false })
  isFluiManaged: boolean;

  /**
   * `shared` (default): PVCs ride the cluster flui-shared (NFS) layer, pods run
   * anywhere. `dedicated`: pod pins to a worker's local disk (no NFS hop) —
   * required by databases where NFS breaks fsync/locking. Source: catalog
   * `spec.persistence.scope`.
   */
  @Column({ type: 'varchar', length: 16, default: 'shared' })
  persistenceScope: 'shared' | 'dedicated';

  /**
   * Worker hosting a `dedicated` app, locked against drain/scale-down while it
   * lives there. Null until the deploy auto-assigns the roomiest worker.
   */
  @Column({ type: 'varchar', length: 253, nullable: true })
  dedicatedNodeName?: string;

  /** Let a `dedicated` app schedule on the master instead of a worker. */
  @Column({ default: false })
  allowMasterPlacement: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  deletedAt?: Date;

  @OneToMany(() => AppRevisionEntity, (revision) => revision.application, {
    cascade: true,
  })
  revisions: AppRevisionEntity[];

  @OneToMany(() => AppResourceEntity, (resource) => resource.application, {
    cascade: true,
  })
  appResources: AppResourceEntity[];
}
