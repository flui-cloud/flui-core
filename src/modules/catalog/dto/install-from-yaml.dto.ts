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
import { ResourceOverridesDto } from './resource-overrides.dto';
import { DependencyChoiceDto } from './dependency-choice.dto';

export class InstallFromYamlDto {
  @ApiProperty({ description: 'Raw .flui.yaml content' })
  @IsString()
  yaml: string;

  @ApiProperty({ description: 'Target cluster UUID' })
  @IsUUID()
  clusterId: string;

  @ApiPropertyOptional({
    description:
      'Display name shown in the dashboard. Defaults to manifest metadata.name.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  displayName?: string;

  @ApiPropertyOptional({
    description: 'Custom FQDN. Omit to let Flui auto-assign or skip endpoint.',
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
      'Certificate issuer override for the app endpoint. Takes precedence over the manifest domain.certificateProvider.',
  })
  @IsOptional()
  @IsIn(['lets-encrypt', 'lets-encrypt-staging'])
  certificateProvider?: 'lets-encrypt' | 'lets-encrypt-staging';

  @ApiPropertyOptional({
    enum: ['ip', 'domain'],
    description:
      'Hostname mode override for the app endpoint. Takes precedence over the manifest domain.hostnameMode.',
  })
  @IsOptional()
  @IsIn(['ip', 'domain'])
  hostnameMode?: 'ip' | 'domain';

  @ApiPropertyOptional({
    description: 'Skip endpoint provisioning at install time.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  skipEndpoint?: boolean;

  @ApiPropertyOptional({
    description:
      'Explicit answers to valueFrom.userInput prompts keyed by env var name. When omitted and the manifest has userInput fields, the server auto-generates test-safe values (useful for smoke tests).',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  userInputs?: Record<string, string>;

  @ApiPropertyOptional({
    description: 'Per-env overrides for entries flagged userEditable:true.',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsOptional()
  @IsObject()
  envOverrides?: Record<string, string>;

  @ApiPropertyOptional({ type: ResourceOverridesDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => ResourceOverridesDto)
  resourceOverrides?: ResourceOverridesDto;

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
    enum: ['public', 'internal'],
    description:
      'Exposure override (only effective when manifest is privatizable).',
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

  @ApiPropertyOptional({
    description:
      'When true, skip the cluster capacity gate and install even if the footprint exceeds free capacity. The user explicitly accepts the risk (pods may be OOM-killed or throttled at peak). Default false.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
