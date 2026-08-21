import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Everything the showcase says about one application, and nothing else: no
 * environment, no cluster, no namespace, no owner.
 */
export class ShowcaseItemDto {
  @ApiProperty() id: string;
  @ApiProperty() name: string;
  @ApiProperty() slug: string;
  @ApiProperty() kind: string;
  @ApiProperty() status: string;

  @ApiPropertyOptional({
    description:
      "The application's own description, which is the line the showcase shows next to it.",
  })
  note: string | null;

  @ApiProperty({
    description:
      'When the application itself was created — the "running here since" the showcase claims.',
  })
  runningSince: Date;

  @ApiPropertyOptional({
    description: 'Where it answers, when it is published.',
  })
  url: string | null;
}
