import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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
}
