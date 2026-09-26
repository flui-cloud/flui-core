import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { AppRuntimeResponseDto } from './app-management.dto';

// ── Section enum ──────────────────────────────────────────────────────────────

/**
 * Identifies which section of the application UI should display the progress
 * indicator for a given rollout event.
 *
 * - `replicas`  → scale operation (replica count changed)
 * - `resources` → update-resources operation (CPU / memory changed)
 * - `pods`      → rolling restart (all pods cycling)
 */
export enum RolloutSection {
  REPLICAS = 'replicas',
  RESOURCES = 'resources',
  PODS = 'pods',
}

// ── Rollout events (immediate ops: restart, scale, update-resources) ──────────

export class RolloutProgressDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  appId: string;

  @ApiProperty({
    example: 'restart',
    enum: ['restart', 'scale', 'update-resources'],
  })
  operation: string;

  /**
   * UI section where the progress indicator should be rendered.
   * The frontend uses this to localise the loading state (e.g. spinner next
   * to the Replicas control, not on the entire application card).
   */
  @ApiProperty({ enum: RolloutSection, example: RolloutSection.REPLICAS })
  section: RolloutSection;

  /**
   * When `true`, the frontend should display an infinite/animated progress bar
   * with no numeric percentage — typically because the rollout progress cannot
   * be measured monotonically (restart, resource changes).
   *
   * When `false`, `percentage` contains a reliable 0-100 value.
   */
  @ApiProperty({ example: false })
  indeterminate: boolean;

  /**
   * Progress percentage (0–100). Always `null` when `indeterminate` is `true`.
   */
  @ApiPropertyOptional({ example: 50, nullable: true })
  percentage: number | null;

  @ApiProperty({ example: 1 })
  readyReplicas: number;

  @ApiProperty({ example: 2 })
  desiredReplicas: number;

  @ApiProperty({ example: 'Waiting for pods to be ready (1/2)' })
  message: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    example: 1,
    description:
      'Replicas waiting for a node with room. While this is set the rollout is waiting on scaling, not failing, and no timeout runs.',
  })
  waitingForRoom?: number;

  @ApiProperty()
  timestamp: Date;
}

export class RolloutCompletedDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  appId: string;

  @ApiProperty({ example: 'restart' })
  operation: string;

  @ApiProperty({ enum: RolloutSection, example: RolloutSection.PODS })
  section: RolloutSection;

  @ApiProperty({ example: 12340, description: 'Duration in milliseconds' })
  duration: number;

  @ApiProperty({ type: AppRuntimeResponseDto })
  runtimeSnapshot: AppRuntimeResponseDto;

  @ApiProperty()
  timestamp: Date;
}

export class RolloutFailedDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  appId: string;

  @ApiProperty({ example: 'restart' })
  operation: string;

  @ApiProperty({ enum: RolloutSection, example: RolloutSection.PODS })
  section: RolloutSection;

  @ApiProperty({ example: 'Rollout timeout after 300s' })
  error: string;

  @ApiProperty()
  timestamp: Date;
}

// ── Operation events (async Bull jobs: deploy, rollback — ready for future use) ──

export class OperationProgressDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  appId: string;

  @ApiProperty({ example: 'op-uuid-...' })
  operationId: string;

  @ApiProperty({
    example: 'deploy_application',
    enum: ['deploy_application', 'rollback_application', 'delete_application'],
  })
  operationType: string;

  @ApiProperty({ example: 45 })
  percentage: number;

  @ApiProperty({ example: 2 })
  currentStep: number;

  @ApiProperty({ example: 5 })
  totalSteps: number;

  @ApiProperty({ example: 'Applying Kubernetes manifests...' })
  message: string;

  @ApiProperty()
  timestamp: Date;
}

export class OperationCompletedDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  appId: string;

  @ApiProperty({ example: 'op-uuid-...' })
  operationId: string;

  @ApiProperty({
    example: 'deploy_application',
    enum: ['deploy_application', 'rollback_application', 'delete_application'],
  })
  operationType: string;

  @ApiProperty({ example: 45000 })
  duration: number;

  /** New application status after the operation completed (e.g. RUNNING, DELETED) */
  @ApiPropertyOptional({ example: 'running' })
  applicationStatus?: string;

  /** Revision number created by this deploy/rollback */
  @ApiPropertyOptional({ example: 3 })
  revisionNumber?: number;

  /** Image reference that was deployed */
  @ApiPropertyOptional({ example: 'ghcr.io/user/app:main-a3f9d1c2' })
  imageRef?: string;

  @ApiPropertyOptional({
    example:
      'sha256:7f6d5e4c3b2a1908070605040302010fefeefefefefefefefefefefefefefefe',
  })
  digest?: string | null;

  @ApiProperty()
  timestamp: Date;
}

export class OperationFailedDto {
  @ApiProperty({ example: 'a1b2c3d4-...' })
  appId: string;

  @ApiProperty({ example: 'op-uuid-...' })
  operationId: string;

  @ApiProperty({
    example: 'deploy_application',
    enum: ['deploy_application', 'rollback_application', 'delete_application'],
  })
  operationType: string;

  @ApiProperty({ example: 'ImagePullBackOff on container "app"' })
  error: string;

  @ApiPropertyOptional({ example: 1 })
  attempt?: number;

  @ApiProperty()
  timestamp: Date;
}

// ── Release events ───────────────────────────────────────────────────────────

export class ReleaseStatusChangedDto {
  @ApiProperty()
  appId: string;

  @ApiProperty()
  operationId: string;

  @ApiProperty({
    example: 'IN_PROGRESS',
    enum: ['IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'ROLLED_BACK'],
  })
  status: string;

  @ApiPropertyOptional()
  imageRef?: string | null;

  @ApiPropertyOptional()
  previousImageRef?: string | null;

  @ApiPropertyOptional()
  buildId?: string | null;

  @ApiPropertyOptional()
  failureReason?: string | null;

  @ApiProperty()
  timestamp: Date;
}

// ── Build events (Path B: K3s Job build pipeline) ─────────────────────────────

export class BuildStartedDto {
  @ApiProperty()
  appId: string;

  @ApiProperty()
  buildId: string;

  @ApiProperty()
  operationId: string;

  @ApiProperty({ example: 'main' })
  branch: string;

  @ApiPropertyOptional()
  commitSha?: string;

  @ApiProperty()
  timestamp: Date;
}

export class BuildLogDto {
  @ApiProperty()
  appId: string;

  @ApiProperty()
  buildId: string;

  @ApiProperty({ example: 'Step 1/3 : FROM node:20-alpine' })
  line: string;

  @ApiProperty({ enum: ['stdout', 'stderr'], example: 'stdout' })
  stream: 'stdout' | 'stderr';

  @ApiProperty()
  timestamp: Date;
}

export class BuildPlanDto {
  @ApiProperty()
  appId: string;

  @ApiProperty()
  buildId: string;

  @ApiProperty({ example: 'Next.js' })
  framework: string;

  @ApiPropertyOptional({ example: 'npm run build' })
  buildCommand?: string;

  @ApiPropertyOptional({ example: 'npm start' })
  startCommand?: string;

  @ApiPropertyOptional()
  raw?: Record<string, any>;

  @ApiProperty()
  timestamp: Date;
}

export class BuildCompletedDto {
  @ApiProperty()
  appId: string;

  @ApiProperty()
  buildId: string;

  @ApiProperty({ example: 'ghcr.io/myorg/myapp:abc123-1700000000' })
  imageRef: string;

  @ApiProperty({ example: 120000, description: 'Duration in milliseconds' })
  duration: number;

  @ApiPropertyOptional({
    description: 'Operation ID of the deploy triggered after this build',
  })
  deployOperationId?: string;

  @ApiProperty()
  timestamp: Date;
}

export class BuildFailedDto {
  @ApiProperty()
  appId: string;

  @ApiProperty()
  buildId: string;

  @ApiProperty()
  operationId: string;

  @ApiProperty({ example: 'railpack build failed: exit code 1' })
  error: string;

  @ApiPropertyOptional({ example: 1 })
  attempt?: number;

  @ApiProperty()
  timestamp: Date;
}
