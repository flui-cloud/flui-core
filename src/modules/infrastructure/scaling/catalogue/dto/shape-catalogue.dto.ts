import { ApiProperty } from '@nestjs/swagger';
import { AvailabilityOutlookDto } from '../../dto/scaling-response.dto';
import { CATALOGUE_READINGS, CatalogueReadingState } from '../catalogue.core';

export class OrderedShapeDto {
  @ApiProperty({ example: 'cx33' })
  shape: string;

  @ApiProperty({
    description:
      'False when this group may not buy it. Listed anyway — the catalogue informs, it does not decide.',
  })
  allowed: boolean;

  @ApiProperty({
    type: AvailabilityOutlookDto,
    nullable: true,
    description:
      'Null when the catalogue does not name this shape, which is not a claim that it is unavailable.',
  })
  outlook: AvailabilityOutlookDto | null;

  @ApiProperty({ description: 'Why it sits where it sits' })
  why: string;
}

export class ShapeCatalogueDto {
  @ApiProperty()
  groupId: string;

  @ApiProperty({ example: 'hetzner' })
  provider: string;

  @ApiProperty({
    enum: CATALOGUE_READINGS,
    description:
      '`no-market` is the operator’s own machines — there is nothing to read, which is not the same as reading nothing.',
  })
  reading: CatalogueReadingState;

  @ApiProperty({
    nullable: true,
    description:
      'Age of the reading these are ordered by. Null is unknown, never zero.',
  })
  ageSeconds: number | null;

  @ApiProperty()
  stale: boolean;

  @ApiProperty({ description: 'What the reading amounts to, in one line' })
  says: string;

  @ApiProperty({
    type: [OrderedShapeDto],
    description:
      'Best-known first. Nothing is dropped: an ordering that removed a rung would be deciding.',
  })
  shapes: OrderedShapeDto[];
}
