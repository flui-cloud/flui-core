import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
} from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { SAFE_NAME } from '../utils/manifest-render.util';

const REF_PATTERN = /^[A-Za-z0-9._\-/]{1,100}$/;

export class PlanManifestsDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'The bootstrap ref to compare against. Omitted means the release this installation pins. A ref that is not a published release needs platform:preview.',
    example: 'v0.13.0',
  })
  @IsOptional()
  @IsString()
  @Matches(REF_PATTERN)
  ref?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'The cluster whose master to compare. Omitted means the control cluster.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  clusterId?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description: 'Limit the plan to these file names.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @Matches(SAFE_NAME, { each: true })
  only?: string[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'Allow replacing a file that changes the image of a stateful component.',
  })
  @IsOptional()
  @IsBoolean()
  allowStatefulImageChange?: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'Allow replacing a file that was changed on the master: one no release this installation may come from reproduces.',
  })
  @IsOptional()
  @IsBoolean()
  allowOverwriteModified?: boolean;
}

export class ApplyManifestsDto extends PlanManifestsDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'The plan id the dry run returned.' })
  @IsString()
  @IsNotEmpty()
  planId: string;
}
