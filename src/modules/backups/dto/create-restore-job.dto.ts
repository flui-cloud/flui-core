import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { RestoreTargetKind, RestoreStrategy } from '../enums/restore-job.enum';
import { RestoreTargetSelector } from '../entities/restore-job.entity';

export class CreateRestoreJobDto {
  @ApiProperty()
  @IsUUID()
  artifactId: string;

  @ApiProperty()
  @IsUUID()
  sourceDestinationId: string;

  @ApiProperty()
  @IsUUID()
  targetClusterId: string;

  @ApiProperty({ enum: RestoreTargetKind })
  @IsEnum(RestoreTargetKind)
  targetKind: RestoreTargetKind;

  @ApiPropertyOptional()
  @IsOptional()
  targetSelector?: RestoreTargetSelector;

  @ApiPropertyOptional({ enum: RestoreStrategy })
  @IsOptional()
  @IsEnum(RestoreStrategy)
  strategy?: RestoreStrategy;

  @ApiPropertyOptional({
    description:
      'PG_PITR only: ISO-8601 instant to recover to; omit for latest (end of WAL).',
  })
  @IsOptional()
  @IsISO8601()
  recoveryTargetTime?: string;
}

export class RestorePreviewDto {
  @ApiProperty()
  @IsUUID()
  artifactId: string;

  @ApiProperty()
  @IsUUID()
  sourceDestinationId: string;
}
