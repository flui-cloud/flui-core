import { Sensitivity } from '../../../mask/decorators/sensitivity.decorator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClusterType } from '../entities/cluster.entity';

export class VNetAttachmentInfoDto {
  @ApiProperty({
    description: 'VNet UUID',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  vnetId: string;

  @ApiProperty({
    description: 'Subnet UUID',
    example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  })
  subnetId: string;

  @ApiProperty({
    description: 'Private IP address assigned in VNet',
    example: '10.0.1.5',
  })
  privateIp: string;

  @ApiPropertyOptional({
    description: 'Timestamp when the node was attached to VNet',
    example: '2024-01-15T10:30:00Z',
  })
  attachedAt?: string;
}

export class ClusterNodeDto {
  @ApiProperty({ description: 'Node ID' })
  id: string;

  @ApiProperty({ description: 'Server name' })
  serverName: string;

  @ApiProperty({
    description: 'Node type',
    enum: ['master', 'worker'],
    example: 'worker',
  })
  nodeType: string;

  @ApiProperty({ description: 'Node IP address', example: '10.0.1.10' })
  ipAddress: string;

  @ApiProperty({
    description: 'Node status',
    enum: ['creating', 'joining', 'ready', 'error', 'deleting'],
    example: 'ready',
  })
  status: string;

  @ApiPropertyOptional({
    description: 'VNet attachment information',
    type: VNetAttachmentInfoDto,
  })
  vnetInfo?: VNetAttachmentInfoDto;

  @ApiPropertyOptional({
    description:
      'Real-time server status from cloud provider (only included when include_real_status=true)',
    example: 'running',
    enum: ['running', 'off', 'starting', 'stopping', 'unknown'],
  })
  provider_status?: string;

  @ApiPropertyOptional({
    description:
      'Whether node status is synced with provider state (only included when include_real_status=true)',
    example: true,
  })
  is_synced?: boolean;

  @ApiProperty({ description: 'Node creation timestamp' })
  createdAt: Date;
}

export class ClusterResponseDto {
  @ApiProperty({ description: 'Cluster ID' })
  id: string;

  @ApiProperty({ description: 'Cluster name', example: 'production-cluster' })
  name: string;

  @ApiProperty({
    description: 'Cloud provider',
    example: 'hetzner',
  })
  provider: string;

  @ApiProperty({ description: 'Region', example: 'fsn1' })
  region: string;

  @ApiProperty({ description: 'Node size', example: 'cx22' })
  nodeSize: string;

  @ApiProperty({ description: 'Current number of nodes', example: 3 })
  nodeCount: number;

  @ApiProperty({
    description: 'Cluster status',
    enum: ['creating', 'ready', 'scaling', 'error', 'deleting', 'deleted'],
    example: 'ready',
  })
  status: string;

  @ApiProperty({
    description: 'Type of cluster (observability or workload)',
    enum: ClusterType,
    example: ClusterType.WORKLOAD,
  })
  clusterType: ClusterType;

  @ApiProperty({ description: 'Autoscaling enabled', example: false })
  autoscalingEnabled: boolean;

  @ApiPropertyOptional({
    description: 'Minimum nodes (autoscaling)',
    example: 2,
  })
  minNodes?: number;

  @ApiPropertyOptional({
    description: 'Maximum nodes (autoscaling)',
    example: 5,
  })
  maxNodes?: number;

  @ApiPropertyOptional({
    description: 'K3s version',
    example: 'v1.35.4+k3s1',
  })
  k3sVersion?: string;

  @ApiPropertyOptional({
    description: 'Master node IP address',
    example: '10.0.1.10',
  })
  masterIpAddress?: string;

  @ApiPropertyOptional({
    description:
      "Why the cluster is in this state, when the state alone does not say. Present on a failure — a refused deletion carries the provider's own sentence, which usually names the remedy as well as the cause.",
    example:
      'Server deletion failed: Server is running. Use force=true to delete running servers.',
  })
  // Arbitrary text rather than exempt: what a provider puts in an error
  // message is not something this codebase gets to promise anything about.
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  statusReason?: string;

  @ApiPropertyOptional({
    description: 'VNet UUID if cluster is attached to a VNet',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  vnetId?: string;

  @ApiPropertyOptional({
    description: 'VNet name if cluster is attached to a VNet',
    example: 'production-vnet',
  })
  vnetName?: string;

  @ApiPropertyOptional({
    description:
      'Grafana Prometheus datasource UID (if cluster is registered to observability)',
    example: 'dfb2lmgjxfaioe',
  })
  grafanaPrometheusUid?: string;

  @ApiPropertyOptional({
    description:
      'Grafana Loki datasource UID (if cluster is registered to observability)',
    example: 'aek3nqjxfbcpqf',
  })
  grafanaLokiUid?: string;

  @ApiProperty({
    description: 'Cluster nodes',
    type: [ClusterNodeDto],
  })
  nodes: ClusterNodeDto[];

  @ApiPropertyOptional({
    description:
      'Real-time cluster status based on all node states (only included when include_real_status=true)',
    example: 'all_running',
    enum: ['all_running', 'all_stopped', 'mixed', 'unknown'],
  })
  cluster_real_status?: string;

  @ApiPropertyOptional({
    description:
      'Whether cluster status is synced with all nodes real state (only included when include_real_status=true)',
    example: true,
  })
  is_synced?: boolean;

  @ApiProperty({ description: 'Cluster creation timestamp' })
  createdAt: Date;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt: Date;
}
