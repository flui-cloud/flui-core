import { ApiProperty, PickType } from '@nestjs/swagger';
import { IsOptional, IsInt, Min, Max, IsString } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * App Logs Query DTO
 *
 * Supports filtering by all indexed Loki labels for Kubernetes app logs.
 */
export class AppLogsQueryDto {
  @ApiProperty({
    description: 'Kubernetes namespace',
    example: 'production',
    required: false,
  })
  @IsOptional()
  @IsString()
  namespace?: string;

  @ApiProperty({
    description: 'Application name (app label)',
    example: 'my-api',
    required: false,
  })
  @IsOptional()
  @IsString()
  app?: string;

  @ApiProperty({
    description: 'Container name',
    example: 'api',
    required: false,
  })
  @IsOptional()
  @IsString()
  container?: string;

  @ApiProperty({
    description: 'Pod name',
    example: 'my-api-7d6b9f-xyz',
    required: false,
  })
  @IsOptional()
  @IsString()
  pod?: string;

  @ApiProperty({
    description: 'Log stream (stdout or stderr)',
    example: 'stderr',
    required: false,
    enum: ['stdout', 'stderr'],
  })
  @IsOptional()
  @IsString()
  stream?: string;

  @ApiProperty({
    description: 'Filter by log level (e.g. info, warn, error)',
    example: 'error',
    required: false,
  })
  @IsOptional()
  @IsString()
  level?: string;

  @ApiProperty({
    description: 'Full-text search query (case insensitive)',
    example: 'connection refused',
    required: false,
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiProperty({
    description: 'Number of log lines to return',
    example: 200,
    default: 200,
    required: false,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  tail?: number = 200;

  @ApiProperty({
    description: 'Start time (ISO 8601)',
    example: '2025-01-18T00:00:00Z',
    required: false,
  })
  @IsOptional()
  @IsString()
  start?: string;

  @ApiProperty({
    description: 'End time (ISO 8601)',
    example: '2025-01-18T23:59:59Z',
    required: false,
  })
  @IsOptional()
  @IsString()
  end?: string;
}

/**
 * App Log Volume Query DTO
 *
 * Used for the log-level-over-time chart (like Grafana log volume panel).
 */
export class AppLogVolumeQueryDto {
  @ApiProperty({
    description: 'Kubernetes namespace',
    example: 'production',
    required: false,
  })
  @IsOptional()
  @IsString()
  namespace?: string;

  @ApiProperty({
    description: 'Application name (app label)',
    example: 'my-api',
    required: false,
  })
  @IsOptional()
  @IsString()
  app?: string;

  @ApiProperty({
    description: 'Container name',
    example: 'api',
    required: false,
  })
  @IsOptional()
  @IsString()
  container?: string;

  @ApiProperty({
    description: 'Log stream (stdout or stderr)',
    example: 'stderr',
    required: false,
    enum: ['stdout', 'stderr'],
  })
  @IsOptional()
  @IsString()
  stream?: string;

  @ApiProperty({
    description: 'Start time (ISO 8601)',
    example: '2025-01-18T00:00:00Z',
    required: true,
  })
  @IsString()
  start: string;

  @ApiProperty({
    description: 'End time (ISO 8601)',
    example: '2025-01-18T23:59:59Z',
    required: true,
  })
  @IsString()
  end: string;

  @ApiProperty({
    description:
      'Bucket size for the time series aggregation (e.g. 1m, 5m, 1h)',
    example: '5m',
    default: '5m',
    required: false,
  })
  @IsOptional()
  @IsString()
  step?: string = '5m';
}

export class ApplicationLogsQueryDto extends PickType(AppLogsQueryDto, [
  'pod',
  'stream',
  'level',
  'search',
  'tail',
  'start',
  'end',
] as const) {}

export class ApplicationLogVolumeQueryDto extends PickType(
  AppLogVolumeQueryDto,
  ['stream', 'start', 'end', 'step'] as const,
) {}
