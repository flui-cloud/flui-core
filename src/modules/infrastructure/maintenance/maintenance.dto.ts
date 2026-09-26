import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayNotEmpty,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import {
  APP_MAINTENANCE_MODES,
  AppMaintenanceMode,
  WEEKDAYS,
  Weekday,
} from './maintenance-window.core';
import {
  DEFERRED_ACTION_KINDS,
  DEFERRED_ACTION_STATUSES,
} from './deferred-action.entity';

export class MaintenanceSlotDto {
  @ApiProperty({ enum: WEEKDAYS, isArray: true, example: ['tue'] })
  @Sensitivity(Sensitivity.PUBLIC)
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(WEEKDAYS, { each: true })
  days: Weekday[];

  @ApiProperty({ example: '02:00', description: 'Local start time, HH:MM' })
  @Sensitivity(Sensitivity.PUBLIC)
  @IsString()
  start: string;

  @ApiProperty({ example: 120, minimum: 15, maximum: 1440 })
  @Sensitivity(Sensitivity.PUBLIC)
  @IsInt()
  @Min(15)
  @Max(1440)
  durationMinutes: number;
}

export class MaintenanceWindowDto {
  @ApiProperty({
    example: 'Europe/Rome',
    description: 'IANA time zone the slots are read in',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  @IsString()
  timezone: string;

  @ApiProperty({ type: [MaintenanceSlotDto] })
  @Sensitivity(Sensitivity.PUBLIC)
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => MaintenanceSlotDto)
  slots: MaintenanceSlotDto[];
}

export class ClusterMaintenanceDto {
  @ApiProperty({
    type: MaintenanceWindowDto,
    nullable: true,
    description: 'Null when no window is set',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  window: MaintenanceWindowDto | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Next time the window is open (now, when it is)',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  nextOpening: string | null;

  @ApiProperty({ description: 'The window in one sentence' })
  @Sensitivity(Sensitivity.PUBLIC)
  says: string;
}

export class SetAppMaintenanceDto {
  @ApiProperty({
    enum: APP_MAINTENANCE_MODES,
    description:
      '`follow` the cluster, keep an `own` window, or take such work at `anytime`',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  @IsIn(APP_MAINTENANCE_MODES)
  mode: AppMaintenanceMode;

  @ApiPropertyOptional({
    type: MaintenanceWindowDto,
    description: 'Required with `own`',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  @IsOptional()
  @ValidateNested()
  @Type(() => MaintenanceWindowDto)
  window?: MaintenanceWindowDto;
}

export class AppMaintenanceDto {
  @ApiProperty({ enum: APP_MAINTENANCE_MODES })
  @Sensitivity(Sensitivity.PUBLIC)
  mode: AppMaintenanceMode;

  @ApiProperty({ type: MaintenanceWindowDto, nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  window: MaintenanceWindowDto | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'When a held change would run; null when none can be held',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  nextOpening: string | null;

  @ApiProperty({
    description: 'Which window governs the app, or why none does',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  says: string;
}

export class DeferredActionDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  id: string;

  @ApiProperty({ enum: DEFERRED_ACTION_KINDS })
  @Sensitivity(Sensitivity.PUBLIC)
  kind: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  clusterId: string;

  @ApiProperty({ nullable: true, type: String })
  @Sensitivity(Sensitivity.PUBLIC)
  applicationId: string | null;

  @ApiProperty({ nullable: true, type: String })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  applicationName: string | null;

  @ApiProperty({ description: 'Who asked for it' })
  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  requestedBy: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  requestedAt: string;

  @ApiProperty({ description: 'The opening it waits for' })
  @Sensitivity(Sensitivity.PUBLIC)
  runAt: string;

  @ApiProperty({ enum: DEFERRED_ACTION_STATUSES })
  @Sensitivity(Sensitivity.PUBLIC)
  status: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'What became of it',
  })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  outcome: string | null;

  @ApiProperty({ description: 'What it does, in a sentence' })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  says: string;
}
