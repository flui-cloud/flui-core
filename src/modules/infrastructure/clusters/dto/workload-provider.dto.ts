import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../../mask/decorators/sensitivity.decorator';

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
}
