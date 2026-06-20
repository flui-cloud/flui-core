import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

// KV v2 paths: slash-delimited segments, no whitespace.
const PATH_PATTERN = /^[^\s][^\s]*$/;

export class SecretsListDto {
  @ApiPropertyOptional({ description: 'Path prefix; empty = mount root.' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  prefix?: string;
}

export class SecretsReadDto {
  @ApiProperty({ description: 'Secret path (e.g. app/db).' })
  @IsString()
  @Matches(PATH_PATTERN, { message: 'Invalid secret path.' })
  @MaxLength(512)
  path!: string;

  @ApiPropertyOptional({
    description: 'Specific version; default latest.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;
}

export class SecretsWriteDto {
  @ApiProperty({ description: 'Secret path to create or update.' })
  @IsString()
  @Matches(PATH_PATTERN, { message: 'Invalid secret path.' })
  @MaxLength(512)
  path!: string;

  @ApiProperty({
    description: 'Flat key/value pairs to store.',
    type: 'object',
    additionalProperties: { type: 'string' },
  })
  @IsObject()
  data!: Record<string, string>;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}

export class SecretsUndeleteDto {
  @ApiProperty({ description: 'Secret path to undelete.' })
  @IsString()
  @Matches(PATH_PATTERN, { message: 'Invalid secret path.' })
  @MaxLength(512)
  path!: string;

  @ApiProperty({ description: 'Soft-deleted version to restore.', minimum: 1 })
  @IsInt()
  @Min(1)
  version!: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}

export class SecretsDeleteDto {
  @ApiProperty({ description: 'Secret path to delete.' })
  @IsString()
  @Matches(PATH_PATTERN, { message: 'Invalid secret path.' })
  @MaxLength(512)
  path!: string;

  @ApiPropertyOptional({
    description:
      'When true, permanently remove the key and every version; otherwise soft-delete the latest version.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  destroy?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}
