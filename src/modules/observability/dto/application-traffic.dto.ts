import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

// =====================================================
// Query DTOs
// =====================================================

const RATE_WINDOW_PATTERN = /^\d+[smhd]$/;

export class TrafficQueryDto {
  @ApiPropertyOptional({
    example: '5m',
    description:
      'Rate window used to compute request rates and percentiles. ' +
      'A shorter window reacts faster but is noisier on low-traffic apps.',
    default: '5m',
  })
  @IsOptional()
  @IsString()
  @Matches(RATE_WINDOW_PATTERN, {
    message: 'window must look like 30s, 5m, 1h or 1d',
  })
  window?: string;
}

export class TrafficHistoryQueryDto extends TrafficQueryDto {
  @ApiProperty({
    example: '2026-07-18T08:00:00.000Z',
    description: 'Range start (ISO 8601)',
  })
  @IsString()
  start: string;

  @ApiProperty({
    example: '2026-07-18T09:00:00.000Z',
    description: 'Range end (ISO 8601)',
  })
  @IsString()
  end: string;

  @ApiPropertyOptional({
    example: '60s',
    description: 'Resolution of the returned series',
    default: '60s',
  })
  @IsOptional()
  @IsString()
  @Matches(RATE_WINDOW_PATTERN, {
    message: 'step must look like 30s, 5m, 1h or 1d',
  })
  step?: string;
}

// =====================================================
// Instant traffic - Sub DTOs
// =====================================================

export class TrafficRateDto {
  @ApiProperty({
    example: 12.4,
    description: 'Requests per second, averaged over the rate window',
    nullable: true,
  })
  requests_per_second: number | null;

  @ApiProperty({
    example: 3720,
    description: 'Approximate request count over the rate window',
    nullable: true,
  })
  requests_in_window: number | null;
}

export class TrafficStatusDto {
  @ApiProperty({ example: 11.9, nullable: true })
  rate_2xx: number | null;

  @ApiProperty({ example: 0.3, nullable: true })
  rate_3xx: number | null;

  @ApiProperty({ example: 0.15, nullable: true })
  rate_4xx: number | null;

  @ApiProperty({ example: 0.05, nullable: true })
  rate_5xx: number | null;

  @ApiProperty({
    example: 0.4,
    description: 'Server errors (5xx) as a percentage of all requests',
    nullable: true,
  })
  server_error_percent: number | null;

  @ApiProperty({
    example: 1.2,
    description: 'Client errors (4xx) as a percentage of all requests',
    nullable: true,
  })
  client_error_percent: number | null;
}

export class TrafficLatencyDto {
  @ApiProperty({ example: 0.012, nullable: true })
  p50_seconds: number | null;

  @ApiProperty({ example: 0.09, nullable: true })
  p90_seconds: number | null;

  @ApiProperty({ example: 0.21, nullable: true })
  p95_seconds: number | null;

  @ApiProperty({ example: 0.87, nullable: true })
  p99_seconds: number | null;

  @ApiProperty({
    example: 0.031,
    description:
      'Mean latency over the rate window (sum/count, not a bucket estimate)',
    nullable: true,
  })
  mean_seconds: number | null;

  @ApiProperty({
    example: true,
    description:
      'True when the histogram has too few buckets for the percentiles to be meaningful. ' +
      'Traefik ships with boundaries at 0.1/0.3/1.2/5s, which cannot resolve sub-second APIs. ' +
      'Consumers should present the percentiles as estimates while this is true.',
  })
  estimates_are_coarse: boolean;

  @ApiProperty({
    example: [0.1, 0.3, 1.2, 5],
    description: 'Histogram bucket boundaries actually present, in seconds',
    type: [Number],
  })
  bucket_boundaries_seconds: number[];
}

export class TrafficMethodBreakdownDto {
  @ApiProperty({ example: 'GET' })
  method: string;

  @ApiProperty({ example: 9.7, nullable: true })
  requests_per_second: number | null;
}

export class TrafficStatusCodeBreakdownDto {
  @ApiProperty({ example: '200' })
  code: string;

  @ApiProperty({ example: 11.4, nullable: true })
  requests_per_second: number | null;
}

export class ApplicationTrafficDto {
  @ApiProperty({ type: TrafficRateDto })
  rate: TrafficRateDto;

  @ApiProperty({ type: TrafficStatusDto })
  status: TrafficStatusDto;

  @ApiProperty({ type: TrafficLatencyDto })
  latency: TrafficLatencyDto;

  @ApiProperty({ type: [TrafficMethodBreakdownDto] })
  by_method: TrafficMethodBreakdownDto[];

  @ApiProperty({ type: [TrafficStatusCodeBreakdownDto] })
  by_status_code: TrafficStatusCodeBreakdownDto[];
}

// =====================================================
// Responses
// =====================================================

export class SingleAppTrafficResponseDto {
  @ApiProperty({ example: '12dcee2c-821a-441d-9b58-384ef9bae02a' })
  app_id: string;

  @ApiProperty({ example: 'vops-api' })
  app_name: string;

  @ApiProperty({ example: 'default' })
  namespace: string;

  @ApiProperty({ example: 'c1a4885e-0000-0000-0000-000000000000' })
  cluster_id: string;

  @ApiProperty({
    example: 'default-vops-api-c9a2jp-svc-7799@kubernetes',
    description: 'Traefik service identifier the metrics were read from',
    nullable: true,
  })
  traefik_service: string | null;

  @ApiProperty({
    example: true,
    description:
      'False when the application is not exposed through the ingress, in which case ' +
      'no edge traffic exists to report and every metric is null.',
  })
  is_routable: boolean;

  @ApiProperty({ example: '5m' })
  window: string;

  @ApiProperty({ type: ApplicationTrafficDto })
  traffic: ApplicationTrafficDto;

  @ApiProperty({ example: '2026-07-18T09:00:00.000Z' })
  queried_at: string;
}

export class TrafficHistoryPointDto {
  @ApiProperty({ example: '2026-07-18T08:00:00.000Z' })
  timestamp: string;

  @ApiProperty({ example: 12.4, nullable: true })
  requests_per_second: number | null;

  @ApiProperty({ example: 0.15, nullable: true })
  rate_4xx: number | null;

  @ApiProperty({ example: 0.05, nullable: true })
  rate_5xx: number | null;

  @ApiProperty({ example: 0.21, nullable: true })
  p95_seconds: number | null;
}

export class SingleAppTrafficHistoryResponseDto {
  @ApiProperty({ example: '12dcee2c-821a-441d-9b58-384ef9bae02a' })
  app_id: string;

  @ApiProperty({ example: 'vops-api' })
  app_name: string;

  @ApiProperty({ example: 'default' })
  namespace: string;

  @ApiProperty({ example: 'c1a4885e-0000-0000-0000-000000000000' })
  cluster_id: string;

  @ApiProperty({ nullable: true })
  traefik_service: string | null;

  @ApiProperty({ example: true })
  is_routable: boolean;

  @ApiProperty({ example: '2026-07-18T08:00:00.000Z' })
  range_start: string;

  @ApiProperty({ example: '2026-07-18T09:00:00.000Z' })
  range_end: string;

  @ApiProperty({ example: '60s' })
  step: string;

  @ApiProperty({ example: '5m' })
  window: string;

  @ApiProperty({ type: [TrafficHistoryPointDto] })
  data_points: TrafficHistoryPointDto[];

  @ApiProperty({ example: '2026-07-18T09:00:00.000Z' })
  queried_at: string;
}

export class ClusterAppTrafficSummaryDto {
  @ApiProperty({ example: '12dcee2c-821a-441d-9b58-384ef9bae02a' })
  app_id: string;

  @ApiProperty({ example: 'vops-api' })
  app_name: string;

  @ApiProperty({ example: 'default' })
  namespace: string;

  @ApiProperty({ nullable: true })
  traefik_service: string | null;

  @ApiProperty({ example: true })
  is_routable: boolean;

  @ApiProperty({ example: 12.4, nullable: true })
  requests_per_second: number | null;

  @ApiProperty({ example: 0.4, nullable: true })
  server_error_percent: number | null;

  @ApiProperty({ example: 0.21, nullable: true })
  p95_seconds: number | null;
}

export class ClusterTrafficResponseDto {
  @ApiProperty({ example: 'c1a4885e-0000-0000-0000-000000000000' })
  cluster_id: string;

  @ApiProperty({ example: '5m' })
  window: string;

  @ApiProperty({ type: [ClusterAppTrafficSummaryDto] })
  applications: ClusterAppTrafficSummaryDto[];

  @ApiProperty({ example: '2026-07-18T09:00:00.000Z' })
  queried_at: string;
}
