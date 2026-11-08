import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../../mask/decorators/sensitivity.decorator';

export class HaPlanServerDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'The location, for example `nbg1`.' })
  zone: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'The size it would be bought as.' })
  shape: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: ['data', 'vote'],
    description:
      '`data`: copies of databases and volumes live here. `vote`: only confirms writes and keeps the cluster deciding.',
  })
  role: 'data' | 'vote';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'The server that starts the cluster.' })
  first: boolean;
}

export class HaPlanResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Whether the provider declares a layout across three locations for this region at all; false, the option is not offered.',
  })
  layoutAvailable: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Whether creating the cluster across three locations would go ahead now, the same answer creating it would give.',
  })
  possible: boolean;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Why not, in words to show, with the sizes every location has when that is what is missing.',
  })
  refusal: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'True when the refusal is a location with none of the sizes while the first one has one: asking again with `completeLater` would go ahead.',
  })
  completeLaterHelps: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The region the three locations belong to.',
  })
  region: string | null;

  @ApiProperty({
    type: [HaPlanServerDto],
    description: 'The servers it would buy, in the order they join.',
  })
  servers: HaPlanServerDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: [String],
    description: 'Locations left to add later, with `completeLater`.',
  })
  later: string[];
}
