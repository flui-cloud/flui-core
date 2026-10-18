import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { TopologyAppDto, TopologyStackDto } from './topology-app.dto';
import { TopologyClusterDto } from './topology-cluster.dto';
import { TopologyClusterLinkDto, TopologyLinkDto } from './topology-link.dto';
import { TopologyServerDto } from './topology-server.dto';

export class TopologyStatsDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  totalClusters: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  totalServers: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  totalStacks: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  totalApps: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  totalReplicas: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  totalRamMB: number;

  @ApiProperty({ description: 'Apps in error' })
  @Sensitivity(Sensitivity.PUBLIC)
  errorCount: number;

  @ApiProperty({ description: 'Apps in warning' })
  @Sensitivity(Sensitivity.PUBLIC)
  warningCount: number;

  @ApiProperty({
    description: 'Apps left out because their placement did not reconcile',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  droppedApps: number;
}

export class TopologyProjectDto {
  @ApiProperty({ format: 'uuid' })
  @Sensitivity(Sensitivity.PUBLIC)
  id: string;

  @ApiProperty({ example: 'Storefront' })
  @Sensitivity(Sensitivity.PUBLIC)
  name: string;
}

export class TopologyResponseDto {
  @ApiProperty({ enum: ['2'], example: '2' })
  @Sensitivity(Sensitivity.PUBLIC)
  version: '2';

  @ApiProperty({ example: '2026-10-17T12:00:00.000Z' })
  @Sensitivity(Sensitivity.PUBLIC)
  generatedAt: string;

  @ApiProperty({ type: [TopologyClusterDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  clusters: TopologyClusterDto[];

  @ApiProperty({ type: [TopologyServerDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  servers: TopologyServerDto[];

  @ApiProperty({ type: [TopologyStackDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  stacks: TopologyStackDto[];

  @ApiProperty({ type: [TopologyAppDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  apps: TopologyAppDto[];

  @ApiProperty({ type: [TopologyLinkDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  links: TopologyLinkDto[];

  @ApiProperty({ type: [TopologyClusterLinkDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  clusterLinks: TopologyClusterLinkDto[];

  @ApiProperty({
    type: [TopologyProjectDto],
    description: 'The projects the apps on the map belong to, and only those',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  projects: TopologyProjectDto[];

  @ApiProperty({ type: TopologyStatsDto })
  @Sensitivity(Sensitivity.PUBLIC)
  stats: TopologyStatsDto;
}
