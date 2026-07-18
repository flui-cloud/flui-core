import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';

export type VariableScope = 'app' | 'system' | 'shared';

export enum VariableType {
  PLAIN = 'plain',
  SENSITIVE = 'sensitive',
  ALL = 'all',
}

// ── App-scoped responses ───────────────────────────────────────────────────

export class UpsertVariablesDto {
  @ApiProperty({
    description: 'Key-value pairs to store',
    example: { NODE_ENV: 'production', LOG_LEVEL: 'info' },
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsObject()
  data: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'Keys to remove. Deletion is explicit: a key missing from `data` is left ' +
      'untouched, so a partial or stale payload can never erase stored config.',
    example: ['LEGACY_FLAG'],
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  deleteKeys?: string[];
}

export class AppVariablesResponseDto {
  @ApiProperty({
    description: 'Internal resource name',
    example: 'app-a1b2c3d4-cm',
  })
  name: string;

  @ApiProperty({ enum: VariableType, example: VariableType.PLAIN })
  type: VariableType;

  @ApiProperty({ enum: ['app', 'system', 'shared'], example: 'app' })
  scope: VariableScope;

  @ApiPropertyOptional({
    description: 'Variable values (only returned for plain type)',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  data?: Record<string, string>;

  @ApiPropertyOptional({
    description:
      'Variable keys (returned for sensitive type — values are never exposed)',
    type: [String],
  })
  keys?: string[];

  @ApiPropertyOptional({ example: '12345' })
  resourceVersion?: string;
}

// ── App-scoped combined response (plain + masked sensitive) ───────────────

export class AppVariableSourcesDto {
  @ApiProperty({ type: [String], example: ['flui-api-config'] })
  configMaps: string[];

  @ApiProperty({ type: [String], example: ['flui-secrets'] })
  secrets: string[];
}

export class AppVariablesCombinedResponseDto {
  @ApiProperty({ description: 'Application slug', example: 'flui-api' })
  name: string;

  @ApiProperty({ enum: VariableType, example: VariableType.ALL })
  type: VariableType;

  @ApiProperty({ enum: ['app', 'system', 'shared'], example: 'app' })
  scope: VariableScope;

  @ApiProperty({
    description: 'All variable values. Sensitive keys show "****" as value.',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { NODE_ENV: 'production', DB_PASSWORD: '****' },
  })
  data: Record<string, string>;

  @ApiProperty({
    description: 'Keys whose values are masked (come from Secrets)',
    type: [String],
    example: ['DB_PASSWORD', 'REDIS_PASSWORD'],
  })
  sensitiveKeys: string[];

  @ApiProperty({ type: () => AppVariableSourcesDto })
  sources: AppVariableSourcesDto;

  @ApiProperty({
    description: 'resourceVersion per ogni ConfigMap/Secret letto',
    type: 'object',
    additionalProperties: { type: 'string' },
    example: { 'flui-api-config': '943', 'flui-secrets': '1021' },
  })
  resourceVersions: Record<string, string>;
}

// ── Cluster-scoped summary (listing) ──────────────────────────────────────

export class VariableSetSummaryDto {
  @ApiProperty({ description: 'Variable set name', example: 'flui-config' })
  name: string;

  @ApiProperty({ enum: ['app', 'system', 'shared'], example: 'system' })
  scope: VariableScope;

  @ApiProperty({ enum: VariableType, example: VariableType.PLAIN })
  type: VariableType;

  @ApiPropertyOptional({ example: '12345' })
  resourceVersion?: string;

  @ApiProperty({
    description: 'Key names present in this variable set',
    example: ['LOG_LEVEL', 'NODE_ENV'],
    type: [String],
  })
  keys: string[];

  @ApiPropertyOptional({
    description: 'Variable values — only present for type=plain',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  data?: Record<string, string>;
}

// ── Cluster-scoped upsert ──────────────────────────────────────────────────

export class UpsertClusterVariablesDto {
  @ApiProperty({
    description: 'Key-value pairs to store',
    example: { LOG_LEVEL: 'debug' },
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsObject()
  data: Record<string, string>;
}

// ── Query param DTO ────────────────────────────────────────────────────────

export class VariableTypeQueryDto {
  @ApiPropertyOptional({
    enum: VariableType,
    description:
      'plain = ConfigMap only, sensitive = Secrets only (masked), all = both (default)',
    example: VariableType.PLAIN,
  })
  @IsOptional()
  @IsEnum(VariableType)
  type?: VariableType;
}
