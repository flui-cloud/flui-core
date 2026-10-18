import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import {
  TopologyClusterType,
  TopologyHealthStatus,
  TopologyOverlay,
} from '../enums/topology.enums';

export class TopologyClusterCountsDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  apps: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  stacks: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  servers: number;

  @ApiProperty({ description: 'Apps in error' })
  @Sensitivity(Sensitivity.PUBLIC)
  errors: number;

  @ApiProperty({ description: 'Apps in warning' })
  @Sensitivity(Sensitivity.PUBLIC)
  warnings: number;
}

export class TopologyInboundRuleDto {
  @ApiProperty({ enum: ['tcp', 'udp', 'icmp'] })
  @Sensitivity(Sensitivity.PUBLIC)
  protocol: 'tcp' | 'udp' | 'icmp';

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'A port or a range such as "30000-32767"; none for icmp',
    example: '443',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  port: string | null;

  @ApiProperty({ example: 'HTTPS' })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  description: string;

  @ApiProperty({ description: 'Open to every address on the Internet' })
  @Sensitivity(Sensitivity.PUBLIC)
  fromAnywhere: boolean;

  @ApiProperty({
    description:
      'How many address ranges may connect; the ranges themselves are not sent',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  sourceCount: number;
}

export class TopologyClusterDto {
  @ApiProperty({ format: 'uuid' })
  @Sensitivity(Sensitivity.PUBLIC)
  id: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  name: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  displayName: string;

  @ApiProperty({ example: 'hetzner' })
  @Sensitivity(Sensitivity.PUBLIC)
  provider: string;

  @ApiProperty({ example: 'fsn1' })
  @Sensitivity(Sensitivity.PUBLIC)
  region: string;

  @ApiProperty({ enum: TopologyClusterType })
  @Sensitivity(Sensitivity.PUBLIC)
  type: TopologyClusterType;

  @ApiProperty({ enum: TopologyHealthStatus })
  @Sensitivity(Sensitivity.PUBLIC)
  status: TopologyHealthStatus;

  @ApiProperty({ type: String, nullable: true, example: 'v1.31.4+k3s1' })
  @Sensitivity(Sensitivity.PUBLIC)
  k3sVersion: string | null;

  @ApiProperty({
    enum: TopologyOverlay,
    description:
      'How the control reaches this cluster: over the Flui network, on its public address, or with the Flui network off',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  overlay: TopologyOverlay;

  @ApiProperty({ type: TopologyClusterCountsDto })
  @Sensitivity(Sensitivity.PUBLIC)
  counts: TopologyClusterCountsDto;

  @ApiProperty({
    type: [TopologyInboundRuleDto],
    nullable: true,
    description:
      'What the firewall Flui applies lets in from the Internet; null when Flui manages no firewall for this cluster',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  inbound: TopologyInboundRuleDto[] | null;
}
