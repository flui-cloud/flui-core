import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

export enum ClusterStorageStatus {
  DISABLED = 'DISABLED',
  PROVISIONING = 'PROVISIONING',
  READY = 'READY',
  DEGRADED = 'DEGRADED',
  ERROR = 'ERROR',
  UNKNOWN = 'UNKNOWN',
}

export class ClusterStorageVolumeDto {
  @ApiProperty({ enum: CloudProvider })
  provider: CloudProvider;

  @ApiProperty({
    description: 'Provider volume id (Hetzner numeric, Scaleway uuid)',
  })
  volumeId: string;

  @ApiProperty({ description: 'Provisioned size in GB' })
  sizeGb: number;

  @ApiPropertyOptional({ description: 'Mount path on the master node' })
  mountPath?: string;

  @ApiPropertyOptional({
    description: 'Filesystem label applied at format time',
  })
  fsLabel?: string;
}

export class ClusterStorageNfsDto {
  @ApiProperty({ description: 'Path exported via NFSv4 from the master' })
  exportPath: string;

  @ApiProperty({ description: 'NFS export options applied on the master' })
  exportOptions: string;

  @ApiProperty({ description: 'NFS mount options applied on the workers' })
  mountOptions: string;

  @ApiProperty({
    description:
      'Whether the master confirms a write before it reaches its disk. When true, the most recent confirmed writes can be lost if the master stops abruptly.',
  })
  confirmsBeforeDisk: boolean;

  @ApiProperty({
    description:
      'What the shared storage promises about confirmed writes, in one sentence',
  })
  durability: string;
}

export class ClusterStoragePvcSummaryDto {
  @ApiProperty({ description: 'Total PVCs bound to flui-shared storage class' })
  bound: number;

  @ApiProperty({
    description: 'Sum of requested storage in GB across bound PVCs',
  })
  requestedGb: number;

  @ApiProperty({
    description: 'Per-namespace breakdown of bound PVC counts',
    type: 'object',
    additionalProperties: { type: 'number' },
    example: { 'flui-app-foo': 2, 'flui-app-bar': 1 },
  })
  byNamespace: Record<string, number>;
}

export class ClusterStorageStatusDto {
  @ApiProperty({ enum: ClusterStorageStatus })
  status: ClusterStorageStatus;

  @ApiProperty({
    description: 'Whether shared storage is enabled on this cluster',
  })
  enabled: boolean;

  @ApiProperty({ description: 'Cluster id this storage belongs to' })
  clusterId: string;

  @ApiPropertyOptional({ type: ClusterStorageVolumeDto })
  volume?: ClusterStorageVolumeDto;

  @ApiPropertyOptional({ type: ClusterStorageNfsDto })
  nfs?: ClusterStorageNfsDto;

  @ApiPropertyOptional({ type: ClusterStoragePvcSummaryDto })
  pvcs?: ClusterStoragePvcSummaryDto;

  @ApiPropertyOptional({
    description:
      'Human-readable explanation when status is DEGRADED/ERROR/UNKNOWN.',
  })
  message?: string;
}
