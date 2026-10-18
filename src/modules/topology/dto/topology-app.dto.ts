import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import {
  TopologyAppCategory,
  TopologyAppKind,
  TopologyAppStatus,
  TopologyExposure,
  TopologyScalingMode,
  TopologyStackType,
  TopologyWorkloadKind,
} from '../enums/topology.enums';

export class TopologyStackDto {
  @ApiProperty({
    description:
      'The catalog install id, or `app:<appId>` for a standalone app',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  id: string;

  @ApiProperty({ format: 'uuid' })
  @Sensitivity(Sensitivity.PUBLIC)
  clusterId: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  name: string;

  @ApiProperty({ enum: TopologyStackType })
  @Sensitivity(Sensitivity.PUBLIC)
  type: TopologyStackType;

  @ApiProperty({ format: 'uuid' })
  @Sensitivity(Sensitivity.PUBLIC)
  primaryAppId: string;

  @ApiProperty({ type: [String] })
  @Sensitivity(Sensitivity.PUBLIC)
  appIds: string[];

  @ApiProperty({
    enum: TopologyAppStatus,
    description: 'The worst status of its apps',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  status: TopologyAppStatus;
}

export class TopologyAppReplicaDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  serverId: string;

  @ApiProperty({ example: 1 })
  @Sensitivity(Sensitivity.PUBLIC)
  count: number;
}

export class TopologyAppDto {
  @ApiProperty({ format: 'uuid' })
  @Sensitivity(Sensitivity.PUBLIC)
  id: string;

  @ApiProperty({ format: 'uuid' })
  @Sensitivity(Sensitivity.PUBLIC)
  clusterId: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  stackId: string;

  @ApiProperty({
    description:
      'Equal across clusters for the same app, so its replicas can be read together',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  groupKey: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  name: string;

  @ApiProperty({ description: 'Short label, at most 14 characters' })
  @Sensitivity(Sensitivity.PUBLIC)
  slug: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  displayName: string;

  @ApiProperty({ enum: TopologyAppCategory })
  @Sensitivity(Sensitivity.PUBLIC)
  category: TopologyAppCategory;

  @ApiProperty({ enum: TopologyAppKind })
  @Sensitivity(Sensitivity.PUBLIC)
  kind: TopologyAppKind;

  @ApiProperty({ enum: TopologyWorkloadKind })
  @Sensitivity(Sensitivity.PUBLIC)
  workloadKind: TopologyWorkloadKind;

  @ApiProperty({ enum: TopologyExposure })
  @Sensitivity(Sensitivity.PUBLIC)
  exposure: TopologyExposure;

  @ApiProperty()
  @Sensitivity(Sensitivity.TENANT_IDENTITY, { screenOnly: true })
  namespace: string;

  @ApiProperty({ enum: TopologyAppStatus })
  @Sensitivity(Sensitivity.PUBLIC)
  status: TopologyAppStatus;

  @ApiProperty({ nullable: true, type: String, example: 'CrashLoopBackOff' })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  statusReason: string | null;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  ramRequestMB: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  ramLimitMB: number;

  @ApiProperty({ description: 'CPU request in millicores' })
  @Sensitivity(Sensitivity.PUBLIC)
  cpuRequestM: number;

  @ApiProperty({ description: 'CPU limit in millicores' })
  @Sensitivity(Sensitivity.PUBLIC)
  cpuLimitM: number;

  @ApiProperty({ description: 'Server of the primary replica' })
  @Sensitivity(Sensitivity.PUBLIC)
  primaryServerId: string;

  @ApiProperty({ type: [TopologyAppReplicaDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  replicas: TopologyAppReplicaDto[];

  @ApiProperty({ description: 'Sum of replicas[].count' })
  @Sensitivity(Sensitivity.PUBLIC)
  replicaCount: number;

  @ApiProperty({ enum: TopologyScalingMode })
  @Sensitivity(Sensitivity.PUBLIC)
  scalingMode: TopologyScalingMode;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    example: 'StatefulSet · 2 replicas',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  scalingNote: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The project the app belongs to; null for one in no project',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  projectId: string | null;
}
