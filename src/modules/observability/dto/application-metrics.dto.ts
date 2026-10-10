import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import {
  CAPACITY_ADVICE,
  CapacityAdvice,
} from '../services/capacity-advice.core';

// =====================================================
// Instant Metrics - Sub DTOs
// =====================================================

export class AppCpuMetricsDto {
  @ApiProperty({
    example: 0.25,
    description: 'Current CPU usage in cores',
    nullable: true,
  })
  usage_cores: number | null;

  @ApiProperty({
    example: 0.5,
    description: 'CPU requests in cores',
    nullable: true,
  })
  requests_cores: number | null;

  @ApiProperty({
    example: 1,
    description: 'CPU limits in cores',
    nullable: true,
  })
  limits_cores: number | null;

  @ApiProperty({
    example: 50,
    description:
      'CPU utilization (usage/limits) percentage — null if no limit is set',
    nullable: true,
  })
  utilization_percent: number | null;
}

export class AppMemoryMetricsDto {
  @ApiProperty({
    example: 134217728,
    description: 'Current memory usage in bytes',
    nullable: true,
  })
  usage_bytes: number | null;

  @ApiProperty({
    example: 268435456,
    description: 'Memory requests in bytes',
    nullable: true,
  })
  requests_bytes: number | null;

  @ApiProperty({
    example: 536870912,
    description: 'Memory limits in bytes',
    nullable: true,
  })
  limits_bytes: number | null;

  @ApiProperty({
    example: 50,
    description:
      'Memory utilization (usage/limits) percentage — null if no limit is set',
    nullable: true,
  })
  utilization_percent: number | null;
}

export class AppNetworkMetricsDto {
  @ApiProperty({
    example: 12345.67,
    description: 'Network receive rate in bytes/sec',
    nullable: true,
  })
  receive_bytes_rate: number | null;

  @ApiProperty({
    example: 9876.54,
    description: 'Network transmit rate in bytes/sec',
    nullable: true,
  })
  transmit_bytes_rate: number | null;
}

export class AppStatusMetricsDto {
  @ApiProperty({
    example: 3,
    description: 'Desired replica count',
    nullable: true,
  })
  replicas_desired: number | null;

  @ApiProperty({
    example: 3,
    description: 'Ready replica count',
    nullable: true,
  })
  replicas_ready: number | null;

  @ApiProperty({
    example: 0,
    description: 'Unavailable replica count',
    nullable: true,
  })
  replicas_unavailable: number | null;

  @ApiProperty({
    example: 1,
    description: 'Ready ratio (0-1)',
    nullable: true,
  })
  ready_ratio: number | null;

  @ApiProperty({
    example: 1,
    description: '1 if all replicas ready, 0 if degraded or down',
    nullable: true,
  })
  up: number | null;

  @ApiProperty({
    example: 5,
    description: 'Total container restart count',
    nullable: true,
  })
  restart_total: number | null;

  @ApiProperty({
    example: 0,
    description: 'Restart rate over the last hour',
    nullable: true,
  })
  restart_rate_1h: number | null;
}

export class AppPodPhaseDto {
  @ApiProperty({ example: 'Running', description: 'Pod phase name' })
  phase: string;

  @ApiProperty({ example: 3, description: 'Number of pods in this phase' })
  count: number;
}

// =====================================================
// Per-Replica Metrics DTOs
// =====================================================

export class ReplicaCpuMetricsDto {
  @ApiProperty({
    example: 0.25,
    description: 'CPU usage in cores for this replica',
    nullable: true,
  })
  usage_cores: number | null;

  @ApiProperty({
    example: 0.5,
    description: 'CPU requests in cores for this replica',
    nullable: true,
  })
  requests_cores: number | null;

  @ApiProperty({
    example: 1,
    description: 'CPU limits in cores for this replica',
    nullable: true,
  })
  limits_cores: number | null;

  @ApiProperty({
    example: 50,
    description:
      'CPU utilization (usage/limits) percentage for this replica — null if no limit is set',
    nullable: true,
  })
  utilization_percent: number | null;
}

export class ReplicaMemoryMetricsDto {
  @ApiProperty({
    example: 134217728,
    description: 'Memory usage in bytes for this replica',
    nullable: true,
  })
  usage_bytes: number | null;

  @ApiProperty({
    example: 268435456,
    description: 'Memory requests in bytes for this replica',
    nullable: true,
  })
  requests_bytes: number | null;

  @ApiProperty({
    example: 536870912,
    description: 'Memory limits in bytes for this replica',
    nullable: true,
  })
  limits_bytes: number | null;

  @ApiProperty({
    example: 50,
    description:
      'Memory utilization (usage/limits) percentage for this replica — null if no limit is set',
    nullable: true,
  })
  utilization_percent: number | null;
}

export class ReplicaNetworkMetricsDto {
  @ApiProperty({
    example: 12345.67,
    description: 'Network receive rate in bytes/sec for this replica',
    nullable: true,
  })
  receive_bytes_rate: number | null;

  @ApiProperty({
    example: 9876.54,
    description: 'Network transmit rate in bytes/sec for this replica',
    nullable: true,
  })
  transmit_bytes_rate: number | null;
}

export class ReplicaStatusMetricsDto {
  @ApiProperty({
    example: 1,
    description: '1 if pod is Ready, 0 if not',
    nullable: true,
  })
  ready: number | null;

  @ApiProperty({
    example: 'Running',
    description: 'Pod phase (Running, Pending, Failed, Succeeded, Unknown)',
    nullable: true,
  })
  phase: string | null;

  @ApiProperty({
    example: 2,
    description: 'Total container restart count for this replica',
    nullable: true,
  })
  restart_total: number | null;

  @ApiProperty({
    example: 0,
    description: 'Restart rate over the last hour for this replica',
    nullable: true,
  })
  restart_rate_1h: number | null;
}

export class ReplicaMetricsDto {
  @ApiProperty({ example: 'my-app-6d4b9f-abc12', description: 'Pod name' })
  pod: string;

  @ApiProperty({ type: ReplicaCpuMetricsDto })
  cpu: ReplicaCpuMetricsDto;

  @ApiProperty({ type: ReplicaMemoryMetricsDto })
  memory: ReplicaMemoryMetricsDto;

  @ApiProperty({ type: ReplicaNetworkMetricsDto })
  network: ReplicaNetworkMetricsDto;

  @ApiProperty({ type: ReplicaStatusMetricsDto })
  status: ReplicaStatusMetricsDto;
}

// =====================================================
// App Health Status DTO (from K8s readiness probe state)
// =====================================================

export class AppHealthStatusDto {
  @ApiPropertyOptional({
    example: 1,
    description: 'Number of ready pods (passed readiness probe)',
    nullable: true,
  })
  ready_pods: number | null;

  @ApiPropertyOptional({
    example: 1,
    description: 'Total desired pods',
    nullable: true,
  })
  total_pods: number | null;

  @ApiPropertyOptional({
    example: 0,
    description: 'Number of pods that are unavailable (failed readiness probe)',
    nullable: true,
  })
  unavailable_pods: number | null;

  @ApiPropertyOptional({
    example: 'Deployment does not have minimum availability.',
    description: 'Condition message from K8s when pods are not ready',
    nullable: true,
  })
  condition_message: string | null;

  @ApiPropertyOptional({
    example: '2026-03-28T10:00:00.000Z',
    description: 'ISO timestamp of the last reconciliation health check',
    nullable: true,
  })
  checked_at: string | null;
}

// =====================================================
// Instant Metrics - App Metrics DTO
// =====================================================

export class AppVolumeMetricsDto {
  @ApiProperty({
    nullable: true,
    description: 'Used bytes across the app PVCs',
  })
  used_bytes: number | null;

  @ApiProperty({ nullable: true, description: 'Total provisioned bytes' })
  capacity_bytes: number | null;

  @ApiProperty({ nullable: true, description: 'Free bytes' })
  available_bytes: number | null;

  @ApiProperty({ nullable: true, description: 'used / capacity * 100' })
  utilization_percent: number | null;

  @ApiProperty({
    enum: ['none', 'warning', 'critical'],
    description: 'Disk near-full level — warning ≥80%, critical ≥95%',
  })
  alert_level: 'none' | 'warning' | 'critical';
}

export class AppMetricsDto {
  @ApiProperty({ description: 'Application ID (from DB)' })
  app_id: string;

  @ApiProperty({
    description: 'Application name (maps to K8s app.kubernetes.io/name label)',
  })
  app_name: string;

  @ApiProperty({ description: 'Kubernetes namespace' })
  namespace: string;

  @ApiProperty({ type: AppCpuMetricsDto })
  cpu: AppCpuMetricsDto;

  @ApiProperty({ type: AppMemoryMetricsDto })
  memory: AppMemoryMetricsDto;

  @ApiProperty({ type: AppNetworkMetricsDto })
  network: AppNetworkMetricsDto;

  @ApiPropertyOptional({
    type: AppVolumeMetricsDto,
    nullable: true,
    description:
      'Persistent volume (disk) usage + near-full alert. Null for apps without a PVC.',
  })
  volume?: AppVolumeMetricsDto | null;

  @ApiProperty({ type: AppStatusMetricsDto })
  status: AppStatusMetricsDto;

  @ApiProperty({
    type: [AppPodPhaseDto],
    description: 'Pod counts by phase',
  })
  pods: AppPodPhaseDto[];

  @ApiProperty({
    type: [ReplicaMetricsDto],
    description: 'Per-replica metrics breakdown (one entry per running pod)',
  })
  replicas: ReplicaMetricsDto[];

  @ApiPropertyOptional({
    type: AppHealthStatusDto,
    description: 'Health status derived from K8s readiness probe state',
    nullable: true,
  })
  health?: AppHealthStatusDto;
}

// =====================================================
// Instant Metrics - Response Wrappers
// =====================================================

export class SingleAppMetricsResponseDto {
  @ApiProperty({ description: 'Application ID' })
  app_id: string;

  @ApiProperty({ description: 'Application name' })
  app_name: string;

  @ApiProperty({ description: 'Kubernetes namespace' })
  namespace: string;

  @ApiProperty({ description: 'Cluster ID' })
  cluster_id: string;

  @ApiProperty({ type: AppMetricsDto })
  metrics: AppMetricsDto;

  @ApiProperty({
    description: 'ISO 8601 timestamp when the query was executed',
  })
  queried_at: string;
}

export class ClusterAppsMetricsResponseDto {
  @ApiProperty({ description: 'Cluster ID' })
  cluster_id: string;

  @ApiProperty({ type: [AppMetricsDto] })
  applications: AppMetricsDto[];

  @ApiProperty({
    description: 'ISO 8601 timestamp when the query was executed',
  })
  queried_at: string;
}

// =====================================================
// History Metrics - Data Point DTO
// =====================================================

export class ReplicaMetricsDataPointDto {
  @ApiProperty({ example: 'my-app-6d4b9f-abc12', description: 'Pod name' })
  pod: string;

  @ApiPropertyOptional({ description: 'CPU usage in cores for this replica' })
  cpu_usage_cores?: number;

  @ApiPropertyOptional({
    description:
      'CPU utilization (usage/limits) percentage for this replica — null if no limit is set',
  })
  cpu_utilization_percent?: number;

  @ApiPropertyOptional({
    description: 'Memory usage in bytes for this replica',
  })
  memory_usage_bytes?: number;

  @ApiPropertyOptional({
    description:
      'Memory utilization (usage/limits) percentage for this replica — null if no limit is set',
  })
  memory_utilization_percent?: number;

  @ApiPropertyOptional({
    description: 'Network receive rate in bytes/sec for this replica',
  })
  network_receive_rate?: number;

  @ApiPropertyOptional({
    description: 'Network transmit rate in bytes/sec for this replica',
  })
  network_transmit_rate?: number;

  @ApiPropertyOptional({
    description: 'Total container restart count for this replica',
  })
  restart_total?: number;
}

export class AppMetricsDataPointDto {
  @ApiProperty({ description: 'Unix timestamp', example: 1707350400 })
  timestamp: number;

  @ApiProperty({
    description: 'ISO 8601 formatted timestamp',
    example: '2026-02-22T10:00:00Z',
  })
  datetime: string;

  @ApiPropertyOptional({ description: 'CPU usage in cores' })
  cpu_usage_cores?: number;

  @ApiPropertyOptional({
    description:
      'CPU utilization (usage/limits) percentage — null if no limit is set',
  })
  cpu_utilization_percent?: number;

  @ApiPropertyOptional({
    description:
      'Share of CPU scheduling periods the limit held the application back, at the worst minute of the step',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  cpu_throttled_percent?: number;

  @ApiPropertyOptional({ description: 'Memory usage in bytes' })
  memory_usage_bytes?: number;

  @ApiPropertyOptional({
    description:
      'Memory utilization (usage/limits) percentage — null if no limit is set',
  })
  memory_utilization_percent?: number;

  @ApiPropertyOptional({
    description: 'Network receive rate in bytes/sec',
  })
  network_receive_rate?: number;

  @ApiPropertyOptional({
    description: 'Network transmit rate in bytes/sec',
  })
  network_transmit_rate?: number;

  @ApiPropertyOptional({ description: 'Desired replica count' })
  replicas_desired?: number;

  @ApiPropertyOptional({ description: 'Ready replica count' })
  replicas_ready?: number;

  @ApiPropertyOptional({ description: 'Total container restart count' })
  restart_total?: number;

  @ApiPropertyOptional({
    type: [ReplicaMetricsDataPointDto],
    description:
      'Per-replica breakdown for this timestamp (one entry per pod that reported data). Omitted if no per-pod series are available.',
  })
  replicas?: ReplicaMetricsDataPointDto[];
}

// =====================================================
// History Metrics - Response Wrappers
// =====================================================

export class SingleAppMetricsHistoryResponseDto {
  @ApiProperty({ description: 'Application ID' })
  app_id: string;

  @ApiProperty({ description: 'Application name' })
  app_name: string;

  @ApiProperty({ description: 'Kubernetes namespace' })
  namespace: string;

  @ApiProperty({ description: 'Cluster ID' })
  cluster_id: string;

  @ApiProperty({
    description: 'Start of the queried time range (ISO 8601)',
  })
  range_start: string;

  @ApiProperty({
    description: 'End of the queried time range (ISO 8601)',
  })
  range_end: string;

  @ApiProperty({ description: 'Resolution step used', example: '60s' })
  step: string;

  @ApiProperty({ type: [AppMetricsDataPointDto] })
  data_points: AppMetricsDataPointDto[];

  @ApiProperty({
    description: 'ISO 8601 timestamp when the query was executed',
  })
  queried_at: string;
}

export class AppMetricsHistoryDto {
  @ApiProperty({ description: 'Application ID' })
  app_id: string;

  @ApiProperty({ description: 'Application name' })
  app_name: string;

  @ApiProperty({ description: 'Kubernetes namespace' })
  namespace: string;

  @ApiProperty({ type: [AppMetricsDataPointDto] })
  data_points: AppMetricsDataPointDto[];
}

export class ClusterAppsMetricsHistoryResponseDto {
  @ApiProperty({ description: 'Cluster ID' })
  cluster_id: string;

  @ApiProperty({
    description: 'Start of the queried time range (ISO 8601)',
  })
  range_start: string;

  @ApiProperty({
    description: 'End of the queried time range (ISO 8601)',
  })
  range_end: string;

  @ApiProperty({ description: 'Resolution step used', example: '60s' })
  step: string;

  @ApiProperty({ type: [AppMetricsHistoryDto] })
  applications: AppMetricsHistoryDto[];

  @ApiProperty({
    description: 'ISO 8601 timestamp when the query was executed',
  })
  queried_at: string;
}

export class AppHealthChecksResponseDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  app_id: string;

  @ApiProperty({
    description:
      'Failed readiness checks in the last hour: each one can take a copy out of the route, and with no other copy visitors get errors',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  readiness: number;

  @ApiProperty({
    description:
      'The readiness failures where the copy was too slow to answer: a busy copy. The others are a copy not listening, mostly while it starts or stops.',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  readiness_busy: number;

  @ApiProperty({ description: 'Failed liveness checks in the last hour' })
  @Sensitivity(Sensitivity.PUBLIC)
  liveness: number;

  @ApiProperty({ description: 'Failed startup checks in the last hour' })
  @Sensitivity(Sensitivity.PUBLIC)
  startup: number;

  @ApiProperty({
    description: 'Copies restarted because their liveness check kept failing',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  restarts_by_liveness: number;

  @ApiPropertyOptional({ nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  last_failure_at: string | null;

  @ApiProperty({
    description:
      'False when the cluster could not be asked: the counts are unknown, not zero',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  read: boolean;
}

export class CapacityMeasuresDto {
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Median, over the minutes of the window, of the share of time the copies were held back by their CPU limit',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  throttled_percent: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Median of the per-minute CPU peaks, as a share of the limit',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  cpu_percent: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Highest memory use in the window, as a share of the limit',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  memory_percent: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'Readiness checks the copies were too slow to answer, in the last hour',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  readiness_failures: number | null;

  @ApiPropertyOptional({ nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  restarts_by_liveness: number | null;
}

export class CapacityThresholdsDto {
  @ApiProperty() @Sensitivity(Sensitivity.PUBLIC) window_minutes: number;
  @ApiProperty() @Sensitivity(Sensitivity.PUBLIC) throttled_percent: number;
  @ApiProperty() @Sensitivity(Sensitivity.PUBLIC) cpu_percent: number;
  @ApiProperty() @Sensitivity(Sensitivity.PUBLIC) memory_percent: number;
  @ApiProperty() @Sensitivity(Sensitivity.PUBLIC) readiness_failures: number;
}

export class CapacityNextCopyDto {
  @ApiProperty({
    description:
      'fits, margin (placed now, in the margin Flui keeps free on each node; nothing is bought), buys (the scaling group buys a node), proposes (a person approves a node), nothing-hosts, unknown',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  verdict: string;

  @ApiProperty() @Sensitivity(Sensitivity.PUBLIC) sentence: string;
}

export class AppCapacityAdviceResponseDto {
  @ApiProperty() @Sensitivity(Sensitivity.PUBLIC) app_id: string;

  @ApiProperty({
    enum: CAPACITY_ADVICE,
    description:
      'none; add_replicas (copies are saturated and another one has room); add_node (another copy has nowhere to run); wait_for_node (copies already wait for a node); raise_autoscale_max; autoscaler_adding; one_copy_only (data on each copy, so more copies do not share the load); watch_memory; unknown (nothing measured)',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  advice: CapacityAdvice;

  @ApiProperty() @Sensitivity(Sensitivity.PUBLIC) sentence: string;

  @ApiProperty({ type: [String] })
  @Sensitivity(Sensitivity.PUBLIC)
  reasons: string[];

  @ApiProperty() @Sensitivity(Sensitivity.PUBLIC) desired: number;
  @ApiProperty() @Sensitivity(Sensitivity.PUBLIC) ready: number;

  @ApiProperty({ type: CapacityMeasuresDto })
  @Sensitivity(Sensitivity.PUBLIC)
  measures: CapacityMeasuresDto;

  @ApiPropertyOptional({ type: CapacityNextCopyDto, nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  next_copy: CapacityNextCopyDto | null;

  @ApiProperty({ type: CapacityThresholdsDto })
  @Sensitivity(Sensitivity.PUBLIC)
  thresholds: CapacityThresholdsDto;
}
