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
  Index,
} from 'typeorm';
import { CompanionsSpec } from '../services/application-manifest-generator.service';
import { v4 as uuidv4 } from 'uuid';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { UserEntity } from '../../auth/entities/user.entity';
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

  @Index()
  @Column({
    type: 'enum',
    enum: ApplicationCategory,
  })
  category: ApplicationCategory;

  @Index()
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

  @Index()
  @Column('uuid')
  clusterId: string;

  // RESTRICT, not CASCADE: a lost cluster's applications are the records a
  // rebuild re-materialises from, and one DELETE on the cluster row must not
  // be able to erase them.
  @ManyToOne(() => ClusterEntity, { onDelete: 'RESTRICT' })
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

  /**
   * Containers that ride with this application without being it, and the pod
   * volumes they need.
   *
   * Persisted rather than derived from the catalog at render time, because a
   * redeploy renders from this row: the catalog is read once, at install. That
   * also means an application installed before its catalog entry declared a
   * companion does not acquire one by being redeployed.
   */
  @Column({ type: 'jsonb', nullable: true })
  companions?: CompanionsSpec;

  @Column({ type: 'uuid', nullable: true })
  currentRevisionId?: string;

  // The single desired-image authority — what this app SHOULD run. Written only
  // via DesiredImageService.setDesiredImage. Never re-derived after build.
  @Column({ length: 255, nullable: true })
  imageRef?: string;

  // Fencing token bumped on every desired-image change; carried by the deploy
  // job so a superseded rollout exits instead of fighting a newer one.
  @Column({ type: 'int', default: 0 })
  desiredImageGeneration: number;

  // Provenance: the immutable build that produced the desired image. Null for
  // docker_image / catalog / raw_manifest apps (no build row).
  @Column({ type: 'uuid', nullable: true })
  desiredBuildId?: string | null;

  // Last image confirmed live on the cluster, written only by the reconciler.
  // desired (imageRef) != observed drives convergence.
  @Column({ length: 255, nullable: true })
  observedImageRef?: string | null;

  @Column({ type: 'text', nullable: true })
  startCommand?: string;

  // Exec-form entrypoint override (full argv, run without a shell). Takes
  // precedence over startCommand. Required for distroless images that have no
  // /bin/sh (e.g. Garage): startCommand wraps in ["/bin/sh","-c"] which fails.
  @Column({ type: 'json', nullable: true })
  command?: string[];

  @Column({ type: 'json', nullable: true })
  securityContext?: ApplicationSecurityContext;

  /**
   * Who owns this application, and now a reference the database enforces.
   *
   * It was a bare varchar with nothing holding it: two rows on the live
   * instance named an owner that no `users` row answered for — one a person the
   * sandbox reaper had removed, one the install credential's declared principal
   * — and an `owner:` selector reaches neither. `ON DELETE SET NULL` is what
   * makes that class impossible instead of merely swept: deleting a person
   * empties the column rather than leaving it pointing at a ghost, which is
   * also the only honest reading, since {@link ownerUserIdFor} and
   * `matchesSelector` already treat a missing owner as "matches nobody".
   *
   * NULL therefore has two legitimate readings, both real on this instance: the
   * platform's own components, which no person created, and an application
   * whose owner has since been deleted.
   */
  @Column({ type: 'uuid', nullable: true })
  userId?: string | null;

  @ManyToOne(() => UserEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'userId' })
  user?: UserEntity;

  /**
   * Where this row came from, as the side that created the thing declared it —
   * `platform` for what the bootstrap installs, `user` for what a person did.
   *
   * Read from `flui.cloud/owner-kind` on the Kubernetes resource discovery
   * finds, never inferred. It exists because {@link userId} was doing two jobs:
   * NULL meant both "the platform put this here" and "an install credential
   * recorded no owner", and a rule that cannot tell them apart has to treat the
   * second like the first. With the declaration in the row, a NULL owner that
   * also carries no declaration is what it always was — a registration defect —
   * and can be refused as one.
   *
   * Plain varchar and nullable on purpose: an enum type would be a type change
   * against a live schema, and the vocabulary belongs to the manifests, which
   * are versioned in another repository and may say something this enum has not
   * heard of yet. Unknown values are read as no declaration.
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  ownerKind?: string | null;

  /**
   * Who declares it, from `flui.cloud/owner-id` — `flui-core` for everything the
   * bootstrap installs today. Not a foreign key and not a `users.id`: it names a
   * *side*, not a person, and the side outlives any row that might stand for it.
   */
  @Column({ type: 'varchar', length: 253, nullable: true })
  ownerRef?: string | null;

  @Column({ default: false })
  systemProtected: boolean;

  @Column({ default: false })
  autoDeploy: boolean;

  /**
   * Continuous auto-deploy policy for git_build apps: when true, a successful
   * CI build on a new commit (discovered by the build watcher or the GitHub
   * Actions webhook) automatically rolls out the new image. When false the
   * image is only recorded as available and a deploy must be triggered
   * manually. Opt-in — does NOT affect the app's very first deploy. Distinct
   * from {@link autoDeploy}, which is a one-shot "deploy right after creation".
   */
  @Column({ default: false })
  deployOnPush: boolean;

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

  /**
   * Owning project (first-class, global grouping). An app belongs to at most one;
   * the IAM selector targets it by the project's slug. Indexed for scope filtering;
   * FK SET NULL so deleting a project just unassigns its apps.
   */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  projectId?: string | null;

  @ManyToOne(() => ProjectEntity, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'projectId' })
  project?: ProjectEntity;

  /**
   * Free-form labels for IAM selector targeting — tags match ALL-of (k8s
   * matchLabels / `@>` containment). jsonb + GIN index (added via migration).
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  tags: string[];

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
