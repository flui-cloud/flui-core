import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ApplicationCategory } from '../enums/application-category.enum';
import { ApplicationKind } from '../enums/application-kind.enum';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { ApplicationStatus } from '../enums/application-status.enum';
import { ApplicationExposure } from '../enums/application-exposure.enum';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';
import { ApplicationResourceKind } from '../enums/application-resource-kind.enum';
import { ApplicationResourceStatus } from '../enums/application-resource-status.enum';
import { AppEventType, AppEventActorType } from '../enums/app-event-type.enum';
import type { AppEventActor } from '../enums/app-event-type.enum';
import { ApplicationResources } from '../interfaces/source-config.interface';

export class ContainerResourcesDto {
  @ApiPropertyOptional({ example: '100m' })
  cpu?: string;

  @ApiPropertyOptional({ example: '128Mi' })
  memory?: string;
}

export class ContainerDetailDto {
  @ApiProperty()
  name: string;

  @ApiProperty({ example: 'nginx:1.25' })
  image: string;

  @ApiProperty({ type: ContainerResourcesDto })
  requests: ContainerResourcesDto;

  @ApiProperty({ type: ContainerResourcesDto })
  limits: ContainerResourcesDto;

  @ApiPropertyOptional({
    type: ContainerResourcesDto,
    description: 'Current usage from metrics-server',
  })
  usage?: ContainerResourcesDto;
}

export class ReplicaInfoDto {
  @ApiPropertyOptional()
  desired?: number;

  @ApiPropertyOptional()
  ready?: number;

  @ApiPropertyOptional()
  available?: number;

  @ApiPropertyOptional()
  unavailable?: number;

  @ApiPropertyOptional()
  updated?: number;
}

export class AppResourceResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ApplicationResourceKind })
  kind: ApplicationResourceKind;

  @ApiProperty()
  name: string;

  @ApiProperty()
  namespace: string;

  @ApiProperty()
  apiVersion: string;

  @ApiProperty({ enum: ApplicationResourceStatus })
  status: ApplicationResourceStatus;

  @ApiProperty({ enum: ReconciliationStatus })
  reconciliationStatus: ReconciliationStatus;

  @ApiPropertyOptional()
  lastObservedAt?: Date;

  @ApiPropertyOptional()
  errorMessage?: string;

  @ApiPropertyOptional()
  metadata?: Record<string, string>;

  @ApiPropertyOptional({
    type: ReplicaInfoDto,
    description: 'Replica counts (Deployment/StatefulSet/DaemonSet)',
  })
  replicas?: ReplicaInfoDto;

  @ApiPropertyOptional({
    type: [ContainerDetailDto],
    description: 'Container specs with requests/limits and live usage',
  })
  containers?: ContainerDetailDto[];

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class AppActorDto {
  @ApiProperty({ enum: AppEventActorType })
  type: AppEventActorType;

  @ApiPropertyOptional()
  id?: string;

  @ApiPropertyOptional()
  name?: string;
}

export class AppRevisionResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: AppEventType })
  eventType: AppEventType;

  @ApiPropertyOptional({ type: AppActorDto })
  actor?: AppEventActor;

  @ApiProperty()
  changeMetadata: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Set only for DEPLOY and ROLLBACK events',
  })
  revisionNumber?: number;

  @ApiPropertyOptional()
  imageRef?: string;

  @ApiPropertyOptional()
  commitSha?: string;

  @ApiPropertyOptional()
  chartVersion?: string;

  @ApiPropertyOptional({ description: 'Resources snapshot at deploy time' })
  resourcesSnapshot?: ApplicationResources;

  @ApiPropertyOptional({
    type: [String],
    description: 'Env var key names present at deploy time (no values)',
  })
  envKeys?: string[];

  @ApiPropertyOptional()
  replicas?: number;

  @ApiProperty({ enum: ApplicationStatus })
  status: ApplicationStatus;

  @ApiPropertyOptional()
  errorMessage?: string;

  @ApiPropertyOptional()
  deployedBy?: string;

  @ApiPropertyOptional()
  operationId?: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Build that produced this revision. Null for image-ref deploys.',
  })
  buildId: string | null;

  @ApiPropertyOptional()
  rollbackReason?: string;

  @ApiProperty()
  createdAt: Date;
}

export class AppAuditEventSummaryDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: AppEventType })
  eventType: AppEventType;

  @ApiPropertyOptional({ type: AppActorDto })
  actor?: AppEventActor;

  @ApiProperty()
  changeMetadata: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Set only for DEPLOY and ROLLBACK events',
  })
  revisionNumber?: number;

  @ApiPropertyOptional()
  imageRef?: string;

  @ApiProperty()
  createdAt: Date;
}

export class AppOperationResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: 'deploy_application' })
  operationType: string;

  @ApiProperty({ example: 'COMPLETED' })
  status: string;

  @ApiProperty({ example: 75 })
  progress: number;

  @ApiPropertyOptional()
  currentStep?: string;

  @ApiProperty()
  currentStepIndex: number;

  @ApiProperty()
  totalSteps: number;

  @ApiPropertyOptional()
  errorMessage?: string;

  @ApiPropertyOptional()
  imageRef?: string;

  @ApiPropertyOptional({ example: 'sha256:...' })
  digest?: string | null;

  @ApiPropertyOptional()
  startedAt?: Date;

  @ApiPropertyOptional()
  completedAt?: Date;

  @ApiProperty()
  createdAt: Date;
}

export class ApplicationResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  slug: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiProperty({ enum: ApplicationCategory })
  category: ApplicationCategory;

  @ApiProperty({
    enum: ApplicationKind,
    description: 'Macro-category that drives top-level menu placement.',
  })
  kind: ApplicationKind;

  @ApiProperty({ enum: ApplicationSourceType })
  sourceType: ApplicationSourceType;

  @ApiProperty()
  clusterId: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Owning project id (null if unassigned)',
  })
  projectId?: string | null;

  @ApiProperty()
  k8sNamespace: string;

  @ApiProperty({ enum: ApplicationStatus })
  status: ApplicationStatus;

  @ApiProperty({ enum: ReconciliationStatus })
  reconciliationStatus: ReconciliationStatus;

  @ApiPropertyOptional()
  lastReconciliationAt?: Date;

  @ApiPropertyOptional()
  reconciliationError?: string;

  @ApiProperty()
  sourceConfig: Record<string, any>;

  @ApiProperty()
  env: Array<{ name: string; value: string; secret?: boolean }>;

  @ApiProperty()
  resources: Record<string, any>;

  @ApiProperty()
  scaling: Record<string, any>;

  @ApiProperty()
  replicas: number;

  @ApiPropertyOptional()
  port?: number;

  @ApiPropertyOptional()
  currentRevisionId?: string;

  @ApiPropertyOptional()
  imageRef?: string;

  @ApiPropertyOptional({
    description:
      'Effective container start command. Null = use image CMD. User-overridable.',
  })
  startCommand?: string | null;

  @ApiPropertyOptional()
  userId?: string;

  @ApiProperty()
  systemProtected: boolean;

  @ApiProperty({
    default: false,
    description: 'When true, new builds automatically trigger a deploy',
  })
  autoDeploy: boolean;

  @ApiProperty({
    enum: ApplicationExposure,
    default: ApplicationExposure.PUBLIC,
    description:
      'How the app is reached. "public" exposes the app via Ingress + Certificate + DNS on a public hostname (external endpoint with its own domain). "internal" means no public exposure: only Deployment + Service ClusterIP exist, and the app is reachable only from the Flui dashboard through the ForwardAuth proxy. Frontend should hide the DNS / domain / certificate tabs when this is "internal".',
  })
  exposure: ApplicationExposure;

  @ApiPropertyOptional({
    description:
      'Fully-qualified public access URL for a `public` app, composed from the app endpoint hostname as `https://<fqdn><entrypointPath>`. This is the real, authoritative link — consumers (dashboard "Open" button, the assistant) MUST use it verbatim and never reconstruct it from the slug. Undefined for internal apps (use `internalUrl`) and for public apps whose endpoint is not provisioned yet.',
    example: 'https://catalog-app.flui.cloud/',
  })
  url?: string;

  @ApiPropertyOptional({
    description:
      'Fully-qualified URL the dashboard should use for the "Open" button when this is an internal app. Composed as `https://<slug>.internal.<clusterZone><entrypointPath>`. Populated only on detail responses (GET /applications/:id and after-create/after-update flows) and only when the cluster currently supports internal hosting (capabilities.hasInternalHosting === true). Undefined for public apps and for internal apps on clusters that do not yet have internal hosting configured — in the latter case the FE must keep the button disabled.',
    example: 'https://pgweb.internal.flui.cloud/',
  })
  internalUrl?: string;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'ID of the currently active revision (alias of currentRevisionId)',
  })
  activeRevisionId: string | null;

  @ApiProperty({
    enum: ['Deployment', 'StatefulSet', 'DaemonSet'],
    description:
      'Kubernetes workload kind generated by Flui. Most apps are Deployments; building-block apps with volumes use StatefulSet so the PVC follows the pod identity.',
  })
  workloadKind: 'Deployment' | 'StatefulSet' | 'DaemonSet';

  @ApiProperty({
    enum: ['shared', 'dedicated'],
    description:
      'Where the app\'s storage lives. "shared" lets the PVC ride on the cluster-wide flui-shared volume (works on any node). "dedicated" pins the pod to one node so the PVC uses local disk on that node — required by databases that need real fsync/locking guarantees.',
  })
  persistenceScope: 'shared' | 'dedicated';

  @ApiPropertyOptional({
    nullable: true,
    description:
      'When persistenceScope=dedicated, the Kubernetes node name the pod is pinned to. Null until the deploy auto-assigns the worker with the most free capacity.',
  })
  dedicatedNodeName?: string | null;

  @ApiProperty({
    description:
      'When persistenceScope=dedicated, whether the app may schedule on the master (control-plane) node instead of a worker. Defaults to false.',
  })
  allowMasterPlacement: boolean;

  @ApiProperty()
  labels: Record<string, string>;

  @ApiProperty()
  metadata: Record<string, string>;

  @ApiPropertyOptional()
  lastDeployedAt?: Date;

  @ApiPropertyOptional()
  buildPath?: string;

  @ApiPropertyOptional()
  frameworkConfirmed?: string;

  @ApiPropertyOptional()
  workflowRunId?: string;

  @ApiPropertyOptional({
    description:
      'Fully-qualified HTML URL of the workflow run on GitHub, cached when the ' +
      'run is first observed. Frontend can link to this directly without ' +
      'resolving owner/repo itself.',
  })
  workflowRunUrl?: string;

  @ApiPropertyOptional({
    description:
      'Timestamp at which the application entered AWAITING_BUILD. Useful to ' +
      'render "building for Xm" and to warn the user when approaching the ' +
      '30-minute build timeout.',
  })
  buildStartedAt?: Date;

  @ApiPropertyOptional({
    description:
      'Snapshot of the GitHub Actions workflow status from the last watcher ' +
      'tick. Frontend should render build-phase UI from this, not from ' +
      'GET /workflow-status (which is a non-canonical pass-through).',
    enum: ['queued', 'in_progress', 'completed'],
  })
  lastBuildStatus?: string;

  @ApiPropertyOptional({
    description:
      'Cached conclusion of the last completed workflow run. Null while the ' +
      'build is still queued or in progress.',
    enum: ['success', 'failure', 'cancelled'],
  })
  lastBuildConclusion?: string;

  @ApiPropertyOptional({
    type: AppOperationResponseDto,
    description: 'Most recent deploy/build operation for this application',
  })
  lastOperation?: AppOperationResponseDto;

  @ApiPropertyOptional({
    description:
      'Catalog slug when this app was installed via the catalog (e.g. "postgresql", "vaultwarden"). Undefined for apps created outside the catalog. Drives the "Installed · N" badge and "Your instances" cross-reference on the catalog pages.',
    example: 'postgresql',
  })
  catalogSlug?: string;

  @ApiPropertyOptional({
    description:
      'Id of the CatalogInstallEntity that created this app. Use it to deep-link from the application detail page back to its catalog install (progress, linked clients, uninstall flow). Undefined for non-catalog apps.',
  })
  catalogInstallId?: string;

  @ApiPropertyOptional({
    description:
      'Catalog version pinned at install time (mirrors metadata.version of the manifest). Compare against the current catalog definition version to flag "update available". Undefined for non-catalog apps.',
    example: '16',
  })
  catalogVersion?: string;

  @ApiPropertyOptional({
    description:
      'Set only within a composed-app group response: true for the component that is the face of the bundle (owns the public endpoint). Undefined in flat listings.',
  })
  isPrimary?: boolean;

  @ApiPropertyOptional({
    description:
      'Set only within a composed-app group response: the bundle display name (e.g. "Nextcloud") this component belongs to. Undefined in flat listings.',
  })
  composedAppName?: string;

  @ApiProperty()
  createdAt: Date;

  @ApiProperty()
  updatedAt: Date;
}

export class DeployOperationDto {
  @ApiProperty({ example: 'uuid-operation-id' })
  id: string;

  @ApiProperty({ example: 'pending' })
  status: string;

  @ApiProperty({ example: 5 })
  totalSteps: number;

  @ApiProperty({ example: 'deploy_application' })
  operationType: string;
}

export class CreateApplicationResponseDto {
  @ApiProperty({ type: ApplicationResponseDto })
  application: ApplicationResponseDto;

  @ApiPropertyOptional({
    type: DeployOperationDto,
    description:
      'Present when autoDeploy: true was requested or buildId was provided',
    nullable: true,
  })
  operation: DeployOperationDto | null;

  @ApiPropertyOptional({
    description:
      'ID of the first revision created when building from a standalone build',
    nullable: true,
  })
  firstRevisionId?: string | null;
}

export class DeleteApplicationResponseDto {
  @ApiProperty({ type: DeployOperationDto })
  operation: DeployOperationDto;
}
