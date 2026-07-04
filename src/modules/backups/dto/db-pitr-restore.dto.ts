import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';

export class DbPitrRestoreDto {
  @ApiProperty({ description: 'Display name for the restored install.' })
  @IsString()
  @Length(1, 120)
  name: string;

  @ApiPropertyOptional({
    description:
      'Target cluster for the new install (defaults to the source app cluster).',
  })
  @IsOptional()
  @IsUUID()
  clusterId?: string;

  @ApiPropertyOptional({
    description:
      'ISO-8601 instant to recover to; omit for latest (end of WAL).',
  })
  @IsOptional()
  @IsISO8601()
  recoveryTargetTime?: string;
}
