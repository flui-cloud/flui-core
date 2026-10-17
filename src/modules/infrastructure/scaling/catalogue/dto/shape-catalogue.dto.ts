import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../../../mask/decorators/sensitivity.decorator';
import { AvailabilityOutlookDto } from '../../dto/scaling-response.dto';
import { CATALOGUE_READINGS, CatalogueReadingState } from '../catalogue.core';
import { ServerArchitecture } from '../../../../providers/core/catalogue/server-architecture';

export class ShapeSpecDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  cores: number;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  memoryMi: number;

  @ApiProperty({ nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  hourlyEur: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'The monthly price the spend ceiling counts, for the first region the group buys in',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  monthlyEur: number | null;
}

export class OrderedShapeDto {
  @ApiProperty({ example: 'cx33' })
  shape: string;

  @ApiProperty({
    description:
      'False when this group may not buy it. Listed anyway — the catalogue informs, it does not decide.',
  })
  allowed: boolean;

  @ApiProperty({
    enum: ['x86', 'arm'],
    nullable: true,
    description:
      'CPU architecture as the provider names it; null where its catalogue was not read. An arm shape is bought like any other, but apps deployed from a repository are built for x86 and will not run on it.',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  architecture: ServerArchitecture | null;

  @ApiProperty({
    type: AvailabilityOutlookDto,
    nullable: true,
    description:
      'Null when the catalogue does not name this shape, which is not a claim that it is unavailable.',
  })
  outlook: AvailabilityOutlookDto | null;

  @ApiProperty({ description: 'Why it sits where it sits' })
  why: string;

  @ApiProperty({
    type: ShapeSpecDto,
    nullable: true,
    description:
      "The machine as the provider describes it; null where the provider's catalogue was not read",
  })
  @Sensitivity(Sensitivity.PUBLIC)
  facts: ShapeSpecDto | null;
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
