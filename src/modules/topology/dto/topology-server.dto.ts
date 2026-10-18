import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import {
  TopologyArchitecture,
  TopologyFluiNetwork,
  TopologyHealthStatus,
  TopologyServerRole,
} from '../enums/topology.enums';

export class TopologyServerCapacityDto {
  @ApiProperty({ description: 'Allocatable CPU in millicores' })
  @Sensitivity(Sensitivity.PUBLIC)
  allocatableCpuM: number;

  @ApiProperty({ description: 'Allocatable memory in MiB' })
  @Sensitivity(Sensitivity.PUBLIC)
  allocatableMemMi: number;

  @ApiProperty({
    description: 'CPU requested by what runs here, in millicores',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  requestedCpuM: number;

  @ApiProperty({ description: 'Memory requested by what runs here, in MiB' })
  @Sensitivity(Sensitivity.PUBLIC)
  requestedMemMi: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'CPU in use, percent of allocatable',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  usedCpuPct: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Memory in use, percent of allocatable',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  usedMemPct: number | null;
}

export class TopologyServerDto {
  @ApiProperty({
    description:
      'The server record id; `node:<clusterId>:<digest>` for a node Flui holds no record of',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  id: string;

  @ApiProperty({ format: 'uuid' })
  @Sensitivity(Sensitivity.PUBLIC)
  clusterId: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  nodeName: string;

  @ApiProperty({ example: 'hetzner' })
  @Sensitivity(Sensitivity.PUBLIC)
  provider: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "The provider's id for this server, for the link to its page",
  })
  @Sensitivity(Sensitivity.TENANT_IDENTITY, { screenOnly: true })
  providerResourceId: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'cx33' })
  @Sensitivity(Sensitivity.PUBLIC)
  serverType: string | null;

  @ApiProperty({ enum: TopologyArchitecture, nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  architecture: TopologyArchitecture | null;

  @ApiProperty({ enum: TopologyServerRole })
  @Sensitivity(Sensitivity.PUBLIC)
  role: TopologyServerRole;

  @ApiProperty({ description: 'Whether new apps may be placed here' })
  @Sensitivity(Sensitivity.PUBLIC)
  takesWork: boolean;

  @ApiProperty({ enum: TopologyHealthStatus })
  @Sensitivity(Sensitivity.PUBLIC)
  status: TopologyHealthStatus;

  @ApiProperty({ type: TopologyServerCapacityDto, nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  capacity: TopologyServerCapacityDto | null;

  @ApiProperty({ description: 'Replicas of Flui-managed apps on this server' })
  @Sensitivity(Sensitivity.PUBLIC)
  podCount: number;

  @ApiProperty({
    description: "Whether the server sits on its provider's private network",
  })
  @Sensitivity(Sensitivity.PUBLIC)
  privateNetwork: boolean;

  @ApiProperty({
    enum: TopologyFluiNetwork,
    description:
      'Its place on the Flui network: connected, waiting for its first handshake, silent, or not on it',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  fluiNetwork: TopologyFluiNetwork;
}
