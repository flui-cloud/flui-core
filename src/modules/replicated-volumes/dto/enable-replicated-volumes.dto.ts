import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  IsBoolean,
} from 'class-validator';

export class EnableReplicatedVolumesDto {
  @ApiPropertyOptional({
    type: [String],
    description:
      "The nodes that hold the copies, one in each of the layout's locations for data: two where the third location only votes, three where every location holds data. Omitted: the nodes already prepared, otherwise one that takes applications in each location for data.",
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(3)
  @IsString({ each: true })
  nodes?: string[];

  @ApiPropertyOptional({
    default: 20,
    minimum: 5,
    maximum: 2000,
    description:
      'Space each of those nodes sets aside for replicated volumes, in GiB, taken from its own disk. Every replicated volume takes its size on each of them.',
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(2000)
  sizeGiB?: number;

  @ApiPropertyOptional({
    default: false,
    description:
      'Accept a region Flui has not validated for high availability. Its three locations are then treated as equal, with no promise about how far apart they are.',
  })
  @IsOptional()
  @IsBoolean()
  force?: boolean;
}
