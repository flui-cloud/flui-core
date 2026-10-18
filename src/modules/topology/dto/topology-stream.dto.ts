import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { TopologyAppStatus, TopologyEventType } from '../enums/topology.enums';
import { TopologyAppDto, TopologyAppReplicaDto } from './topology-app.dto';
import { TopologyClusterLinkDto, TopologyLinkDto } from './topology-link.dto';
import {
  TopologyServerCapacityDto,
  TopologyServerDto,
} from './topology-server.dto';

export class TopologyServerCapacityChangeDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  serverId: string;

  @ApiProperty({ format: 'uuid' })
  @Sensitivity(Sensitivity.PUBLIC)
  clusterId: string;

  @ApiProperty({ type: TopologyServerCapacityDto, nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  capacity: TopologyServerCapacityDto | null;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  podCount: number;
}

export class TopologyStreamPayloadDto {
  @ApiPropertyOptional({ type: TopologyAppDto, description: 'app.deployed' })
  @Sensitivity(Sensitivity.PUBLIC)
  app?: TopologyAppDto;

  @ApiPropertyOptional({ description: 'app.* events' })
  @Sensitivity(Sensitivity.PUBLIC)
  appId?: string;

  @ApiPropertyOptional({
    enum: TopologyAppStatus,
    description: 'app.status_changed',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  status?: TopologyAppStatus;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'app.status_changed',
  })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  statusReason?: string | null;

  @ApiPropertyOptional({
    type: [TopologyAppReplicaDto],
    description: 'app.scaled',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  replicas?: TopologyAppReplicaDto[];

  @ApiPropertyOptional({ description: 'app.scaled' })
  @Sensitivity(Sensitivity.PUBLIC)
  replicaCount?: number;

  @ApiPropertyOptional({
    nullable: true,
    type: String,
    description: 'app.scaled',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  scalingNote?: string | null;

  @ApiPropertyOptional({ format: 'uuid', description: 'server.* events' })
  @Sensitivity(Sensitivity.PUBLIC)
  clusterId?: string;

  @ApiPropertyOptional({ type: TopologyServerDto, description: 'server.added' })
  @Sensitivity(Sensitivity.PUBLIC)
  server?: TopologyServerDto;

  @ApiPropertyOptional({ description: 'server.removed' })
  @Sensitivity(Sensitivity.PUBLIC)
  serverId?: string;

  @ApiPropertyOptional({
    type: [TopologyServerCapacityChangeDto],
    description: 'server.capacity: only the servers that changed',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  capacities?: TopologyServerCapacityChangeDto[];

  @ApiPropertyOptional({
    type: [TopologyLinkDto],
    description: 'links.changed: the full set',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  links?: TopologyLinkDto[];

  @ApiPropertyOptional({
    type: [TopologyClusterLinkDto],
    description: 'links.changed',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  clusterLinks?: TopologyClusterLinkDto[];

  @ApiPropertyOptional({ description: 'heartbeat' })
  @Sensitivity(Sensitivity.PUBLIC)
  ts?: string;
}

export class TopologyStreamMessageDto {
  @ApiProperty({ enum: TopologyEventType })
  @Sensitivity(Sensitivity.PUBLIC)
  type: TopologyEventType;

  @ApiProperty({ type: TopologyStreamPayloadDto })
  @Sensitivity(Sensitivity.PUBLIC)
  data: TopologyStreamPayloadDto;
}
