import {
  IsString,
  IsOptional,
  IsEnum,
  IsIn,
  IsInt,
  IsBoolean,
  IsArray,
  IsObject,
  IsUUID,
  Min,
  Max,
  ValidateNested,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ApplicationCategory } from '../enums/application-category.enum';
import { ApplicationKind } from '../enums/application-kind.enum';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { ApplicationExposure } from '../enums/application-exposure.enum';
import {
  ApplicationHealthProbe,
  ApplicationSecurityContext,
  ApplicationVolume,
} from '../interfaces/source-config.interface';

class ExternalSecretRefDto {
  @ApiProperty()
  @IsString()
  secretName: string;

  @ApiProperty()
  @IsString()
  key: string;
}

class EnvVarDto {
  @ApiProperty({ example: 'NODE_ENV' })
  @IsString()
  name: string;

  @ApiProperty({ example: 'production' })
  @IsString()
  value: string;

  @ApiPropertyOptional({
    example: false,
    description: 'If true, value is encrypted at rest',
  })
  @IsOptional()
  secret?: boolean;

  @ApiPropertyOptional({
    description:
      'When set, the env is rendered as a K8s secretKeyRef to an externally-owned Secret (e.g. a catalog building block). Flui never stores or reads the value — the pod resolves it at start time. Used by catalog client linking.',
    type: ExternalSecretRefDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ExternalSecretRefDto)
  externalSecretRef?: ExternalSecretRefDto;
}

class ResourceLimitDto {
  @ApiPropertyOptional({ example: '100m' })
  @IsOptional()
  @IsString()
  request?: string;

  @ApiPropertyOptional({ example: '500m' })
  @IsOptional()
  @IsString()
  limit?: string;
}

class ApplicationResourcesDto {
  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => ResourceLimitDto)
  cpu?: ResourceLimitDto;

  @ApiPropertyOptional()
  @IsOptional()
  @ValidateNested()
  @Type(() => ResourceLimitDto)
  memory?: ResourceLimitDto;
}

class ApplicationScalingDto {
  @ApiProperty({ example: false })
  enabled: boolean;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  minReplicas?: number;

  @ApiPropertyOptional({ example: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxReplicas?: number;

  @ApiPropertyOptional({ example: 80 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  targetCPU?: number;

  @ApiPropertyOptional({ example: 80 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  targetMemory?: number;
}

export class CreateApplicationDto {
  @ApiProperty({ example: 'my-nextjs-app', description: 'Human-readable name' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiPropertyOptional({
    description:
      'Explicit slug. When set, used verbatim instead of a randomly-suffixed one — lets composed components have deterministic, FQDN-predictable names (and makes re-processing idempotent). Caller guarantees uniqueness.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  slug?: string;

  @ApiPropertyOptional({ description: 'Optional description' })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiProperty({ enum: ApplicationCategory, example: ApplicationCategory.USER })
  @IsEnum(ApplicationCategory)
  category: ApplicationCategory;

  @ApiPropertyOptional({
    enum: ApplicationKind,
    example: ApplicationKind.APPLICATION,
    description:
      'Macro-category for top-level menu placement. Defaults to APPLICATION when omitted.',
  })
  @IsOptional()
  @IsEnum(ApplicationKind)
  kind?: ApplicationKind;

  @ApiProperty({
    enum: ApplicationSourceType,
    example: ApplicationSourceType.DOCKER_IMAGE,
  })
  @IsEnum(ApplicationSourceType)
  sourceType: ApplicationSourceType;

  @ApiPropertyOptional({
    example: 'default',
    description: 'Kubernetes namespace',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  k8sNamespace?: string;

  @ApiProperty({
    description: 'Polymorphic source configuration based on sourceType',
    example: {
      type: 'docker_image',
      imageRef: 'nginx:1.25',
      pullPolicy: 'IfNotPresent',
    },
  })
  @IsObject()
  sourceConfig: Record<string, any>;

  @ApiPropertyOptional({
    type: [EnvVarDto],
    description: 'Environment variables',
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EnvVarDto)
  env?: EnvVarDto[];

  @ApiPropertyOptional({
    type: ApplicationResourcesDto,
    description: 'CPU and memory limits',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApplicationResourcesDto)
  resources?: ApplicationResourcesDto;

  @ApiPropertyOptional({
    type: ApplicationScalingDto,
    description: 'Autoscaling configuration',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ApplicationScalingDto)
  scaling?: ApplicationScalingDto;

  @ApiPropertyOptional({ example: 1, description: 'Number of replicas' })
  @IsOptional()
  @IsInt()
  @Min(0)
  replicas?: number;

  @ApiPropertyOptional({ example: 3000, description: 'Main container port' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiPropertyOptional({
    enum: ['http', 'tcp'],
    description: 'Wire protocol of the main port (gates Prometheus scraping)',
  })
  @IsOptional()
  @IsIn(['http', 'tcp'])
  portProtocol?: 'http' | 'tcp';

  @ApiPropertyOptional({
    description:
      'Files mounted into the pod from the app Secret (path+content).',
  })
  @IsOptional()
  @IsArray()
  configFiles?: Array<{ path: string; content: string }>;

  @ApiPropertyOptional({ description: 'K8s-style labels' })
  @IsOptional()
  @IsObject()
  labels?: Record<string, string>;

  @ApiPropertyOptional({ description: 'Flexible metadata' })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, string>;

  @ApiPropertyOptional({
    enum: ['nano', 'small', 'medium', 'large', 'xlarge'],
    example: 'medium',
    description:
      'Named resource profile for CPU/RAM allocation. ' +
      'Ignored if "resources" is also specified (raw values take priority). ' +
      'If neither is provided, defaults to "small".',
  })
  @IsOptional()
  @IsEnum(['nano', 'small', 'medium', 'large', 'xlarge'])
  resourceProfile?: 'nano' | 'small' | 'medium' | 'large' | 'xlarge';

  @ApiPropertyOptional({
    description:
      'Readiness probe configuration. If not provided, no probe is injected into the Deployment.',
    example: { type: 'http', httpPath: '/', httpPort: 80 },
  })
  @IsOptional()
  @IsObject()
  healthProbe?: ApplicationHealthProbe;

  @ApiPropertyOptional({
    description:
      'Optional persistent volumes. Each entry produces a PVC and is mounted at mountPath inside the container.',
    isArray: true,
  })
  @IsOptional()
  @IsArray()
  volumes?: ApplicationVolume[];

  @ApiPropertyOptional({
    enum: ['Deployment', 'StatefulSet', 'DaemonSet'],
    description: 'Kubernetes workload kind. Defaults to Deployment.',
  })
  @IsOptional()
  @IsEnum(['Deployment', 'StatefulSet', 'DaemonSet'])
  workloadKind?: 'Deployment' | 'StatefulSet' | 'DaemonSet';

  @ApiPropertyOptional({
    enum: ['shared', 'dedicated'],
    description:
      'Storage placement: `shared` (default) for stateless apps using NFS layer; `dedicated` pins the pod to the master node so writes hit the backing Volume directly (required by databases where NFS breaks fsync/locking).',
  })
  @IsOptional()
  @IsEnum(['shared', 'dedicated'])
  persistenceScope?: 'shared' | 'dedicated';

  @ApiPropertyOptional({
    description:
      'Target k8s node name when `persistenceScope=dedicated`. If omitted, the app is auto-pinned at deploy time to the worker with the most free capacity. When set, the named node becomes "locked" (no drain, no scale-down) for as long as it hosts the app.',
  })
  @IsOptional()
  @IsString()
  dedicatedNodeName?: string;

  @ApiPropertyOptional({
    description:
      'When `persistenceScope=dedicated`, allow the app to schedule on the master (control-plane) node instead of a worker. Defaults to false — dedicated apps are confined to workers, and a deploy fails loudly if no worker exists.',
  })
  @IsOptional()
  @IsBoolean()
  allowMasterPlacement?: boolean;

  @ApiPropertyOptional({
    description:
      'Override the container start command. Used to wrap/compose env vars before exec (e.g. catalog clients that need DATABASE_URL composed from PGHOST/PGUSER/PGPASSWORD at runtime).',
  })
  @IsOptional()
  @IsString()
  startCommand?: string;

  @ApiPropertyOptional({
    description:
      'Pod/container security settings (fsGroup, runAsUser/runAsGroup, runAsNonRoot, hardened). Emitted into the workload only for the fields that are set. Used so non-root images can write a persistent volume (fsGroup).',
  })
  @IsOptional()
  @IsObject()
  securityContext?: ApplicationSecurityContext;

  @ApiPropertyOptional({
    example: true,
    description:
      'If true, automatically trigger a deploy immediately after creation. ' +
      'The response will include an operation object for tracking progress.',
  })
  @IsOptional()
  @IsBoolean()
  autoDeploy?: boolean;

  @ApiPropertyOptional({
    enum: ApplicationExposure,
    default: ApplicationExposure.PUBLIC,
    description:
      'How the app is reached. "public" (default) creates Ingress + Certificate + DNS on a public hostname. "internal" skips all public exposure: only Deployment + Service ClusterIP are created, and the app is reachable only from the Flui dashboard through the ForwardAuth proxy.',
  })
  @IsOptional()
  @IsEnum(ApplicationExposure)
  exposure?: ApplicationExposure;

  @ApiPropertyOptional({
    description:
      'ID of a completed standalone build to create the application from. ' +
      'When provided, the app is created atomically and a deploy is triggered immediately. ' +
      'The build must be COMPLETED and not yet linked to any application.',
  })
  @IsOptional()
  @IsUUID()
  buildId?: string;
}
