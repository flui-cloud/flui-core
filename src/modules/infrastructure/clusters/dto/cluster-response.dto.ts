import { Sensitivity } from '../../../mask/decorators/sensitivity.decorator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ClusterType } from '../entities/cluster.entity';
import { RELEASE } from '../../../../config/release.config';

export class VNetAttachmentInfoDto {
  @ApiProperty({
    description: 'VNet UUID',
    example: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  vnetId: string;

  @ApiProperty({
    description: 'Subnet UUID',
    example: 'b2c3d4e5-f6a7-8901-bcde-f12345678901',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  subnetId: string;

  @ApiProperty({
    description: 'Private IP address assigned in VNet',
    example: '10.0.1.5',
  })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  privateIp: string;

  @ApiPropertyOptional({
    description: 'Timestamp when the node was attached to VNet',
    example: '2024-01-15T10:30:00Z',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  attachedAt?: string;
}

export class ClusterNodeDto {
  @ApiProperty({ description: 'Node ID' })
  @Sensitivity(Sensitivity.PUBLIC)
  id: string;

  @ApiProperty({ description: 'Server name' })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  serverName: string;

  @ApiProperty({
    description: 'Node type',
    enum: ['master', 'worker'],
    example: 'worker',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  nodeType: string;

  @ApiProperty({ description: 'Node IP address', example: '10.0.1.10' })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  ipAddress: string;

  @ApiProperty({
    description: 'Node status',
    enum: ['creating', 'joining', 'ready', 'error', 'deleting'],
    example: 'ready',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  status: string;

  @ApiPropertyOptional({
    description: 'VNet attachment information',
    type: VNetAttachmentInfoDto,
  })
  @Sensitivity(Sensitivity.PUBLIC)
  vnetInfo?: VNetAttachmentInfoDto;

  @ApiPropertyOptional({
    description:
      'Real-time server status from cloud provider (only included when include_real_status=true)',
    example: 'running',
    enum: ['running', 'off', 'starting', 'stopping', 'unknown'],
  })
  @Sensitivity(Sensitivity.PUBLIC)
  provider_status?: string;

  @ApiPropertyOptional({
    description:
      'Whether node status is synced with provider state (only included when include_real_status=true)',
    example: true,
  })
  @Sensitivity(Sensitivity.PUBLIC)
  is_synced?: boolean;

  @ApiProperty({ description: 'Node creation timestamp' })
  @Sensitivity(Sensitivity.PUBLIC)
  createdAt: Date;
}

export class ClusterResponseDto {
  @ApiProperty({ description: 'Cluster ID' })
  @Sensitivity(Sensitivity.PUBLIC)
  id: string;

  @ApiProperty({ description: 'Cluster name', example: 'production-cluster' })
  @Sensitivity(Sensitivity.PUBLIC)
  name: string;

  @ApiProperty({
    description: 'Cloud provider',
    example: 'hetzner',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  provider: string;

  @ApiProperty({ description: 'Region', example: 'fsn1' })
  @Sensitivity(Sensitivity.PUBLIC)
  region: string;

  @ApiProperty({ description: 'Node size', example: 'cx22' })
  @Sensitivity(Sensitivity.PUBLIC)
  nodeSize: string;

  @ApiProperty({ description: 'Current number of nodes', example: 3 })
  @Sensitivity(Sensitivity.PUBLIC)
  nodeCount: number;

  @ApiProperty({
    description: 'Cluster status',
    enum: ['creating', 'ready', 'scaling', 'error', 'deleting', 'deleted'],
    example: 'ready',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  status: string;

  @ApiProperty({
    description: 'Type of cluster (observability or workload)',
    enum: ClusterType,
    example: ClusterType.WORKLOAD,
  })
  @Sensitivity(Sensitivity.PUBLIC)
  clusterType: ClusterType;

  @ApiProperty({ description: 'Autoscaling enabled', example: false })
  @Sensitivity(Sensitivity.PUBLIC)
  autoscalingEnabled: boolean;

  @ApiPropertyOptional({
    description: 'Minimum nodes (autoscaling)',
    example: 2,
  })
  @Sensitivity(Sensitivity.PUBLIC)
  minNodes?: number;

  @ApiPropertyOptional({
    description: 'Maximum nodes (autoscaling)',
    example: 5,
  })
  @Sensitivity(Sensitivity.PUBLIC)
  maxNodes?: number;

  @ApiPropertyOptional({
    description: 'K3s version',
    example: RELEASE.k3s.version,
  })
  @Sensitivity(Sensitivity.PUBLIC)
  k3sVersion?: string;

  @ApiPropertyOptional({
    description: 'Master node IP address',
    example: '10.0.1.10',
  })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
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
  @Sensitivity(Sensitivity.PUBLIC)
  vnetId?: string;

  @ApiPropertyOptional({
    description: 'VNet name if cluster is attached to a VNet',
    example: 'production-vnet',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  vnetName?: string;

  @ApiPropertyOptional({
    description:
      'Grafana Prometheus datasource UID (if cluster is registered to observability)',
    example: 'dfb2lmgjxfaioe',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  grafanaPrometheusUid?: string;

  @ApiPropertyOptional({
    description:
      'Grafana Loki datasource UID (if cluster is registered to observability)',
    example: 'aek3nqjxfbcpqf',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  grafanaLokiUid?: string;

  @ApiProperty({
    description: 'Cluster nodes',
    type: [ClusterNodeDto],
  })
  @Sensitivity(Sensitivity.PUBLIC)
  nodes: ClusterNodeDto[];

  @ApiPropertyOptional({
    description:
      'Real-time cluster status based on all node states (only included when include_real_status=true)',
    example: 'all_running',
    enum: ['all_running', 'all_stopped', 'mixed', 'unknown'],
  })
  @Sensitivity(Sensitivity.PUBLIC)
  cluster_real_status?: string;

  @ApiPropertyOptional({
    description:
      'Whether cluster status is synced with all nodes real state (only included when include_real_status=true)',
    example: true,
  })
  @Sensitivity(Sensitivity.PUBLIC)
  is_synced?: boolean;

  @ApiProperty({ description: 'Cluster creation timestamp' })
  @Sensitivity(Sensitivity.PUBLIC)
  createdAt: Date;

  @ApiProperty({ description: 'Last update timestamp' })
  @Sensitivity(Sensitivity.PUBLIC)
  updatedAt: Date;
}
