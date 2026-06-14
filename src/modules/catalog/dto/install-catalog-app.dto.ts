import {
  IsArray,
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DependencyChoiceDto } from './dependency-choice.dto';
import { ResourceOverridesDto } from './resource-overrides.dto';

export class InstallCatalogAppDto {
  @ApiProperty({ description: 'Target cluster UUID' })
  @IsUUID()
  clusterId: string;

  @ApiProperty({
    description: 'User-chosen display name shown in the dashboard',
  })
  @IsString()
  @MaxLength(255)
  displayName: string;

  @ApiPropertyOptional({
    description:
      'Custom FQDN for the app. When omitted and the cluster has a DNS zone + wildcard issuer configured, Flui auto-assigns {install-slug}.{zoneName}. When omitted and the cluster has no zone/issuer, no endpoint is provisioned and the user configures DNS/TLS later from the app page.',
  })
  @IsOptional()
  @IsString()
  domain?: string;

  @ApiPropertyOptional({
    enum: ['http-01', 'dns-01'],
    description:
      'ACME challenge override. Overrides manifest domain.certChallenge; http-01 forces a per-host cert even on a wildcard zone. Default: derived from cluster config.',
  })
  @IsOptional()
  @IsIn(['http-01', 'dns-01'])
  certChallenge?: 'http-01' | 'dns-01';

  @ApiPropertyOptional({
    enum: ['lets-encrypt', 'lets-encrypt-staging'],
    description:
      'Certificate issuer override. Overrides manifest domain.certificateProvider.',
  })
  @IsOptional()
  @IsIn(['lets-encrypt', 'lets-encrypt-staging'])
  certificateProvider?: 'lets-encrypt' | 'lets-encrypt-staging';

  @ApiPropertyOptional({
    enum: ['ip', 'domain'],
    description:
      'Hostname mode override. Overrides manifest domain.hostnameMode.',
  })
  @IsOptional()
  @IsIn(['ip', 'domain'])
  hostnameMode?: 'ip' | 'domain';

  @ApiPropertyOptional({
    description:
      'When true, skip endpoint (DNS + certificate) provisioning at install time even if the cluster is ready. The user will configure domain and TLS later. Default false.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  skipEndpoint?: boolean;

  @ApiPropertyOptional({
    description:
      'When the app uses dedicated (node-local) storage, allow its components to schedule on the control-plane node instead of requiring a worker. Set this when the target cluster has no worker node so the install does not fail. Defaults to false.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  allowMasterPlacement?: boolean;

  @ApiPropertyOptional({
    description:
      'Answers to valueFrom.userInput prompts keyed by env var name.',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  userInputs?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'Per-env overrides for entries flagged userEditable:true in the manifest.',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  envOverrides?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'Dependency resolution choices (DEDICATED vs REUSE_EXISTING). Required when the manifest declares dependencies.',
    type: [DependencyChoiceDto],
  })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => DependencyChoiceDto)
  dependencyChoices?: DependencyChoiceDto[];

  @ApiPropertyOptional({
    type: ResourceOverridesDto,
    description:
      'Override the CPU/memory/replicas declared in the manifest. Useful when the cluster is resource-constrained (scale down) or when the user wants extra headroom (scale up). Any field omitted falls back to the manifest default. The cluster capacity check is still enforced on the effective values.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ResourceOverridesDto)
  resourceOverrides?: ResourceOverridesDto;

  @ApiPropertyOptional({
    enum: ['public', 'internal'],
    description:
      "Override the manifest's default exposure at install time. Only effective when the catalog app reports `privatizable: true`. Omit to use the manifest default.",
  })
  @IsOptional()
  @IsIn(['public', 'internal'])
  exposure?: 'public' | 'internal';

  @ApiPropertyOptional({
    enum: ['native', 'oidc', 'proxy', 'none'],
    description:
      'Authentication method chosen at install, among spec.auth.modes. Defaults to spec.auth.default (or native).',
  })
  @IsOptional()
  @IsIn(['native', 'oidc', 'proxy', 'none'])
  authMode?: 'native' | 'oidc' | 'proxy' | 'none';

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'boolean' },
    description:
      'Install-time feature toggles (spec.options[].key → enabled). Omitted keys fall back to the option default.',
  })
  @IsOptional()
  @IsObject()
  options?: Record<string, boolean>;
}
