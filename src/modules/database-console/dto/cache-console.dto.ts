import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from 'class-validator';

// Memcached keys: up to 250 bytes, no whitespace (the protocol delimiter).
const KEY_PATTERN = /^\S{1,250}$/;

export class CacheKeyDto {
  @ApiProperty({ description: 'Exact key to fetch.' })
  @IsString()
  @Matches(KEY_PATTERN, { message: 'Invalid Memcached key.' })
  key!: string;
}

export class CacheSetDto {
  @ApiProperty({ description: 'Key to store.' })
  @IsString()
  @Matches(KEY_PATTERN, { message: 'Invalid Memcached key.' })
  key!: string;

  @ApiProperty({ description: 'Value to store (UTF-8 text).' })
  @IsString()
  @MaxLength(1_000_000)
  value!: string;

  @ApiPropertyOptional({
    description: 'Seconds until expiry; 0 (default) never expires.',
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  ttlSeconds?: number;

  @ApiPropertyOptional({ description: 'Opaque client flags.', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  flags?: number;

  @ApiPropertyOptional({
    description:
      'When true (default) the write is refused; send false to apply.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}

export class CacheDeleteDto {
  @ApiProperty({ description: 'Key to delete.' })
  @IsString()
  @Matches(KEY_PATTERN, { message: 'Invalid Memcached key.' })
  key!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}

export class CacheFlushDto {
  @ApiPropertyOptional({
    description:
      'When true (default) the flush is refused; send false to apply.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}
