import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsUUID,
  IsOptional,
  IsBoolean,
  IsIn,
  IsFQDN,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

export class DeployDomainOverrideDto {
  @ApiPropertyOptional({
    description: 'Auto-create the AppEndpoint after deploy.',
  })
  @IsOptional()
  @IsBoolean()
  auto?: boolean;

  @ApiPropertyOptional({ description: 'Provision a TLS certificate.' })
  @IsOptional()
  @IsBoolean()
  tls?: boolean;

  @ApiPropertyOptional({
    description: 'Explicit FQDN to expose on. Taken verbatim.',
    example: 'staging.example.com',
  })
  @IsOptional()
  @IsFQDN()
  fqdn?: string;

  @ApiPropertyOptional({ enum: ['ip', 'domain'] })
  @IsOptional()
  @IsIn(['ip', 'domain'])
  hostnameMode?: 'ip' | 'domain';

  @ApiPropertyOptional({ enum: ['http-01', 'dns-01'] })
  @IsOptional()
  @IsIn(['http-01', 'dns-01'])
  certChallenge?: 'http-01' | 'dns-01';

  @ApiPropertyOptional({ enum: ['lets-encrypt', 'lets-encrypt-staging'] })
  @IsOptional()
  @IsIn(['lets-encrypt', 'lets-encrypt-staging'])
  certificateProvider?: 'lets-encrypt' | 'lets-encrypt-staging';
}

export class DeployOverridesDto {
  @ApiPropertyOptional({
    description:
      'Release name, overriding metadata.name. Part of the app identity ' +
      '(cluster, repository, branch, name), so the same repo and branch can be ' +
      'installed more than once. Not remembered between deploys — pass it every ' +
      'time you target that install.',
    example: 'my-app-staging',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiPropertyOptional({ enum: ['public', 'internal'] })
  @IsOptional()
  @IsIn(['public', 'internal'])
  exposure?: 'public' | 'internal';

  @ApiPropertyOptional({
    description: 'Endpoint overrides (FQDN, TLS, ACME challenge, issuer).',
    type: DeployDomainOverrideDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeployDomainOverrideDto)
  domain?: DeployDomainOverrideDto;
}

export class DeployFromYamlDto {
  @ApiProperty({ description: 'Raw flui.yaml content (kind: Application)' })
  @IsString()
  @IsNotEmpty()
  yaml: string;

  @ApiProperty({ description: 'Target cluster UUID' })
  @IsUUID()
  clusterId: string;

  @ApiProperty({
    description: 'GitHub repository full name (owner/repo)',
    example: 'acme/my-astro-app',
  })
  @IsString()
  @IsNotEmpty()
  repoFullName: string;

  @ApiPropertyOptional({
    description: 'Git branch to deploy from',
    default: 'main',
  })
  @IsOptional()
  @IsString()
  branch?: string;

  @ApiPropertyOptional({
    description: 'Environment variable overrides (KEY=value map)',
    example: { DATABASE_URL: 'postgres://...' },
  })
  @IsOptional()
  envOverrides?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'Install-time overrides of manifest fields that belong to the installation ' +
      'rather than to the code (release name, exposure, endpoint/domain). ' +
      'Persisted on the application and re-applied on every later manifest deploy, ' +
      'so an install never silently reverts to the manifest value. ' +
      'Combine with a distinct name to deploy the same repo twice on one cluster.',
    type: DeployOverridesDto,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => DeployOverridesDto)
  overrides?: DeployOverridesDto;

  @ApiPropertyOptional({
    description:
      'Validate manifest without triggering a deploy. Returns the effective ' +
      'manifest (overrides and branch environment applied) in effectiveYaml.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  validateOnly?: boolean;

  @ApiPropertyOptional({
    description:
      'Skip the GitHub Actions build step and re-deploy the current imageRef. ' +
      'Useful for fast iterations on the manifest config (env, ports, healthcheck, endpoint) ' +
      'without rebuilding the image. ' +
      'If the app was deleted, falls back to GHCR latest-tag lookup for {owner}/{repoName}.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  skipBuild?: boolean;

  @ApiPropertyOptional({
    description:
      'Explicit image reference to deploy (e.g. ghcr.io/owner/repo:sha). ' +
      'Skips the build pipeline. Takes precedence over skipBuild auto-discovery. ' +
      'Use for rollback to a specific tag, or to deploy a known image when the app was deleted from Flui.',
    example: 'ghcr.io/dawit-io/flui-astro-test:ea9f0cc',
  })
  @IsOptional()
  @IsString()
  imageRef?: string;
}

export class DeployFromYamlResponseDto {
  @ApiProperty() applicationId: string;
  @ApiProperty() slug: string;
  @ApiProperty() name: string;
  @ApiProperty() status: string;
  @ApiPropertyOptional() workflowRunUrl?: string;
  @ApiPropertyOptional() workflowUrl?: string;
  @ApiPropertyOptional({
    description: 'Set when skipBuild=true — track via /operations/:id',
  })
  operationId?: string;

  @ApiPropertyOptional({
    description:
      'The manifest actually applied, with the branch environment and the ' +
      'install-time overrides baked in. Returned on validateOnly requests — ' +
      'use it to preview or download what a deploy would produce.',
  })
  effectiveYaml?: string;
}
