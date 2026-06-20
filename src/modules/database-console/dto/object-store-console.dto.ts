import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class OsCreateBucketDto {
  @ApiProperty()
  @IsString()
  @MaxLength(63)
  bucket!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}

export class OsSetBucketPolicyDto {
  @ApiProperty()
  @IsString()
  @MaxLength(63)
  bucket!: string;

  @ApiProperty({
    description:
      'true enables anonymous public read (Garage website access); false keeps the bucket private (key-only).',
  })
  @IsBoolean()
  public!: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}

export class OsListObjectsDto {
  @ApiProperty()
  @IsString()
  @MaxLength(63)
  bucket!: string;

  @ApiPropertyOptional({ description: 'Key prefix ("folder") to list under.' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  prefix?: string;

  @ApiPropertyOptional({
    description: 'Delimiter for folder-style listing (usually "/").',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1)
  delimiter?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  continuationToken?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 1000 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxKeys?: number;
}

export class OsObjectRefDto {
  @ApiProperty()
  @IsString()
  @MaxLength(63)
  bucket!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(1024)
  key!: string;
}

export class OsDeleteDto {
  @ApiProperty()
  @IsString()
  @MaxLength(63)
  bucket!: string;

  @ApiPropertyOptional({ description: 'Single object key to delete.' })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  key?: string;

  @ApiPropertyOptional({
    description: 'Prefix ("folder") — deletes every object under it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1024)
  prefix?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  readOnly?: boolean;
}

export class OsShareDto {
  @ApiProperty()
  @IsString()
  @MaxLength(63)
  bucket!: string;

  @ApiProperty()
  @IsString()
  @MaxLength(1024)
  key!: string;

  @ApiPropertyOptional({
    description: 'Link lifetime in seconds (60 .. 604800). Default 3600.',
  })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(604800)
  ttlSeconds?: number;
}
