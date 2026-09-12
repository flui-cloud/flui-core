import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Sensitivity } from '../../../mask/decorators/sensitivity.decorator';

export class NameAvailabilityResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Whether this name can be used for a new cluster right now — checked ' +
      "against both Flui's own records and the cloud provider's real resource " +
      'inventory, so a name freed by a soft-deleted cluster whose server ' +
      'survived at the provider is still refused.',
  })
  available: boolean;

  // Quotes the proposed name and provider back, same shape as
  // RebuildPlanResponseDto.refusals.
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({
    description: 'Why the name is unavailable. Omitted when available is true.',
  })
  reason?: string;
}
