import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
