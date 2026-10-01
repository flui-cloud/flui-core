import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsUUID,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { RestoreTargetSelectorDto } from './selector.dto';
import {
  RestoreTargetKind,
  RestoreStrategy,
  RestorePlacement,
} from '../enums/restore-job.enum';

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
      'Beside the original (`new`) or onto it (`existing`). A database restore ' +
      'always builds a new install, so this is recorded as `new` whatever is sent.',
  })
  @IsOptional()
  @IsEnum(RestorePlacement)
  placement?: RestorePlacement;

  @ApiPropertyOptional({ type: RestoreTargetSelectorDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => RestoreTargetSelectorDto)
  targetSelector?: RestoreTargetSelectorDto;

  @ApiPropertyOptional({
    enum: RestoreStrategy,
    description:
      'Ignored: the strategy is the one of the engine that wrote the backup.',
  })
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
