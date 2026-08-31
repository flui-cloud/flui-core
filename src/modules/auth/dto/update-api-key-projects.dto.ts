import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsOptional, IsString } from 'class-validator';

export class UpdateApiKeyProjectsDto {
  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description:
      'The new, complete list of project ids this key may act on. Omit (or ' +
      'send an empty array) to lift the restriction entirely. This is ' +
      'independent of `applicationIds` — clearing one does not touch the ' +
      'other, since the two are alternatives, not a single combined list.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  projectIds?: string[];
}
