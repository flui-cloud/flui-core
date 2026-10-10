import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class NodeTrafficDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  clusterId: string;

  @ApiProperty({ description: 'Node name' })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  node: string;

  @ApiProperty({ description: 'Sustained over ten minutes, public interface' })
  @Sensitivity(Sensitivity.PUBLIC)
  mbpsOut: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  mbpsIn: number;

  @ApiProperty({
    description:
      'Outgoing bytes a month would carry at the last seven days pace',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  monthPaceBytes: number;

  @ApiPropertyOptional({
    nullable: true,
    description:
      'What the provider includes each month, in TB; null when not metered',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  includedTb: number | null;
}

export class EdgeTrafficDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  clusterId: string;

  @ApiProperty({ description: 'Requests per second, last five minutes' })
  @Sensitivity(Sensitivity.PUBLIC)
  rpsNow: number;

  @ApiProperty({ description: 'Requests per second over the six hours before' })
  @Sensitivity(Sensitivity.PUBLIC)
  rpsBefore: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  rateLimited10m: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  requests10m: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  serverErrors10m: number;
}

export class TrafficThresholdsDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  nodeMbps: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  monthlyTrafficPercent: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  spikeFactor: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  spikeMinRps: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  rateLimitedPer10m: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  edgeErrorPercent: number;
}

export class TrafficWatchDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  measuredAt: Date;

  @ApiProperty({ type: [NodeTrafficDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  nodes: NodeTrafficDto[];

  @ApiProperty({ type: [EdgeTrafficDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  edges: EdgeTrafficDto[];

  @ApiProperty({ type: TrafficThresholdsDto })
  @Sensitivity(Sensitivity.PUBLIC)
  thresholds: TrafficThresholdsDto;
}
