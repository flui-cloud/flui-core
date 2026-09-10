import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { RemovalSnapshotOfferDto } from './removal-preview.dto';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

/** What `DELETE /applications/:id/install` decided and started. */
export class AppRemovalResponseDto {
  @ApiProperty({
    enum: ['catalog-install', 'application'],
    description:
      'Which removal actually ran: the whole catalog install, or this ' +
      'application on its own.',
  })
  removed: 'catalog-install' | 'application';

  @ApiProperty({
    description:
      'The async operation to follow. Empty only for an install that was ' +
      'already removed before this call.',
  })
  operationId: string;

  @ApiProperty({
    description: 'Status of that operation when it was returned.',
  })
  status: string;

  @ApiProperty({ description: 'True only when nothing is left to wait for.' })
  done: boolean;

  @ApiPropertyOptional({
    description:
      'Set when the removal was already underway or complete, so the caller ' +
      'knows nothing new was started.',
  })
  alreadyUnderway?: boolean;

  @ApiPropertyOptional({
    description: 'Human-readable label for a progress widget.',
  })
  label?: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    type: [RemovalSnapshotOfferDto],
    description:
      'The services this application had attached to itself, uninstalled with ' +
      'it. Present on the RESPONSE and not only on the preview on purpose: a ' +
      'cascade that takes a database away must say so even to a caller that ' +
      'never asked for the preview.',
  })
  attachedServicesRemoved: RemovalSnapshotOfferDto[];

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({
    description:
      'The same sentence the preview gives, as it stood the moment the ' +
      'removal started. Null only when the removal provably took no storage.',
  })
  dataWarning?: string | null;
}
