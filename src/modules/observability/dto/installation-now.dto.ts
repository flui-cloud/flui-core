import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { RegistryTrafficDto } from '../../flui-registry/dto/registry-traffic.dto';
import {
  EdgeTrafficDto,
  NodeTrafficDto,
  TrafficThresholdsDto,
} from './traffic-watch.dto';

export class NodeNowDto extends NodeTrafficDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  clusterName: string;

  @ApiPropertyOptional({ nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  cpuPercent: number | null;

  @ApiPropertyOptional({ nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  memoryPercent: number | null;
}

export class EdgeNowDto extends EdgeTrafficDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  clusterName: string;
}

export class PlatformComponentNowDto {
  @ApiProperty({ description: 'Platform component, e.g. flui-api, postgres' })
  @Sensitivity(Sensitivity.PUBLIC)
  name: string;

  @ApiPropertyOptional({ nullable: true, description: 'Of its limit' })
  @Sensitivity(Sensitivity.PUBLIC)
  cpuPercent: number | null;

  @ApiPropertyOptional({ nullable: true, description: 'Of its limit' })
  @Sensitivity(Sensitivity.PUBLIC)
  memoryPercent: number | null;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  restartsLastHour: number;
}

export class SandboxNowDto {
  @ApiProperty({ description: 'Spaces held by a visitor' })
  @Sensitivity(Sensitivity.PUBLIC)
  live: number;

  @ApiProperty({ description: 'Spaces built and waiting' })
  @Sensitivity(Sensitivity.PUBLIC)
  warm: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  ceiling: number;

  @ApiProperty({ description: 'People on the waiting list without an offer' })
  @Sensitivity(Sensitivity.PUBLIC)
  waiting: number;

  @ApiProperty({
    description: 'Visitors turned away because nothing was ready',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  fullRefusals: number;
}

export class AlertsNowDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  firing: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  critical: number;

  @ApiProperty({ type: [String] })
  @Sensitivity(Sensitivity.PUBLIC)
  names: string[];
}

export class InstallationNowDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  measuredAt: Date;

  @ApiProperty({ type: [NodeNowDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  nodes: NodeNowDto[];

  @ApiProperty({ type: [EdgeNowDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  edges: EdgeNowDto[];

  @ApiProperty({ type: [PlatformComponentNowDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  platform: PlatformComponentNowDto[];

  @ApiPropertyOptional({
    type: RegistryTrafficDto,
    nullable: true,
    description: 'Last hour; null when images are kept on GHCR',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  registry: RegistryTrafficDto | null;

  @ApiPropertyOptional({
    type: SandboxNowDto,
    nullable: true,
    description: 'Null when the public demo is off',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  sandbox: SandboxNowDto | null;

  @ApiProperty({ type: AlertsNowDto })
  @Sensitivity(Sensitivity.PUBLIC)
  alerts: AlertsNowDto;

  @ApiProperty({ type: TrafficThresholdsDto })
  @Sensitivity(Sensitivity.PUBLIC)
  thresholds: TrafficThresholdsDto;
}
