import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../../mask/decorators/sensitivity.decorator';

export class EnvironmentNetworkDto {
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ description: "The environment network's name." })
  name: string;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({ description: 'The subnet the cluster joins, as a CIDR.' })
  ipRange: string;
}

export class WorkloadProviderResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'The provider asked about.' })
  provider: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Whether a workload cluster on this provider can be created here now — ' +
      'the same answer creating one would give.',
  })
  allowed: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    type: String,
    description: "The control cluster's provider, or null before one exists.",
  })
  controlProvider: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Whether the Flui management overlay is switched on for this installation.',
  })
  overlayEnabled: boolean;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Why the provider cannot host a workload cluster here. Null when allowed.',
  })
  reason: string | null;

  @ApiProperty({
    nullable: true,
    type: EnvironmentNetworkDto,
    description:
      "The network a cluster on this provider joins without being asked: the control cluster's own, shared by every cluster on its provider. Null where the cluster brings its own.",
  })
  environmentNetwork: EnvironmentNetworkDto | null;
}
