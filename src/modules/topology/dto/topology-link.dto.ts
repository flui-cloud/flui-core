import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import {
  TopologyEndpointKind,
  TopologyLinkSource,
} from '../enums/topology.enums';

export class TopologyLinkEndpointDto {
  @ApiProperty({ enum: TopologyEndpointKind })
  @Sensitivity(Sensitivity.PUBLIC)
  kind: TopologyEndpointKind;

  @ApiPropertyOptional({ format: 'uuid' })
  @Sensitivity(Sensitivity.PUBLIC)
  appId?: string;
}

export class TopologyLinkTrafficDto {
  @ApiProperty({ description: 'Whether the traffic on this link is measured' })
  @Sensitivity(Sensitivity.PUBLIC)
  measured: boolean;

  @ApiProperty({ type: Number, nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  rps: number | null;

  @ApiProperty({ type: Number, nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  errorPct: number | null;
}

export class TopologyLinkDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  id: string;

  @ApiProperty({ type: TopologyLinkEndpointDto })
  @Sensitivity(Sensitivity.PUBLIC)
  from: TopologyLinkEndpointDto;

  @ApiProperty({ type: TopologyLinkEndpointDto })
  @Sensitivity(Sensitivity.PUBLIC)
  to: TopologyLinkEndpointDto;

  @ApiProperty({ enum: TopologyLinkSource })
  @Sensitivity(Sensitivity.PUBLIC)
  source: TopologyLinkSource;

  @ApiProperty({
    description: 'A port or protocol, never a host',
    example: ':5432',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  label: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  crossCluster: boolean;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  viaTunnel: boolean;

  @ApiProperty({ type: String, nullable: true })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER, { screenOnly: true })
  routeHost: string | null;

  @ApiProperty({ type: String, nullable: true, example: '/api' })
  @Sensitivity(Sensitivity.PUBLIC)
  routePath: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'The app port a gateway route delivers to',
    example: 8080,
  })
  @Sensitivity(Sensitivity.PUBLIC)
  targetPort: number | null;

  @ApiProperty({ type: TopologyLinkTrafficDto })
  @Sensitivity(Sensitivity.PUBLIC)
  traffic: TopologyLinkTrafficDto;
}

export class TopologyClusterLinkDto {
  @ApiProperty({ format: 'uuid' })
  @Sensitivity(Sensitivity.PUBLIC)
  fromClusterId: string;

  @ApiProperty({ format: 'uuid' })
  @Sensitivity(Sensitivity.PUBLIC)
  toClusterId: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  linkCount: number;

  @ApiProperty({ type: Number, nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  rps: number | null;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  viaTunnel: boolean;
}
