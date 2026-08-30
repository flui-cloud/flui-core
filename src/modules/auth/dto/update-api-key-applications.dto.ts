import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsOptional, IsString } from 'class-validator';

export class UpdateApiKeyApplicationsDto {
  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description:
      'The new, complete list of application ids this key may act on. Omit ' +
      '(or send an empty array) to lift the restriction entirely — the key ' +
      'then reaches every application its holder can already access, same as ' +
      'a key minted with no `applicationIds` at all.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  applicationIds?: string[];
}
