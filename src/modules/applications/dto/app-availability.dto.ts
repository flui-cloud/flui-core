import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class AvailabilityReasonDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: [
      'single_copy',
      'copies_on_one_node',
      'single_ingress_node',
      'dedicated_placement',
      'volume_on_one_node',
      'ip_hostname',
    ],
  })
  code: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({ description: 'What to change, in one sentence' })
  message: string;
}

export class AppAvailabilityResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Keeps answering, with its data, when one worker of its cluster is lost. The database and the cluster master remain single points either way.',
  })
  highlyAvailable: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [AvailabilityReasonDto] })
  reasons: AvailabilityReasonDto[];
}
