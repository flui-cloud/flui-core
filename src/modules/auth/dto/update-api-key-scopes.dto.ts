import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayUnique,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class UpdateApiKeyScopesDto {
  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description:
      "The key's new, complete list of scopes. Send this or `add`, not both.",
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  scopes?: string[];

  @ApiPropertyOptional({
    isArray: true,
    type: String,
    description:
      'Scopes to add to the ones the key already carries. What an agent sends ' +
      'when it asks for one more tool: the request a person reads then names ' +
      'only what changes.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  add?: string[];

  @ApiPropertyOptional({
    description:
      'Why, in one line, shown to the person deciding. Written by whoever asks, ' +
      'so it is read as their claim, not as a fact.',
    maxLength: 200,
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}
