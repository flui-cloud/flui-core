import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import {
  RestoreTargetKind,
  RestoreStrategy,
  RestorePlacement,
} from '../enums/restore-job.enum';
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

  @ApiPropertyOptional({
    enum: RestorePlacement,
    description:
      'Beside the original (`new`) or onto it, replacing what is there (`existing`). ' +
      'Required for cluster, namespace and application restores, where both are ' +
      'possible and the old default was neither. Derived for the engines that have ' +
      'only one meaning: a database PITR always builds a new install.',
  })
  @IsOptional()
  @IsEnum(RestorePlacement)
  placement?: RestorePlacement;

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
