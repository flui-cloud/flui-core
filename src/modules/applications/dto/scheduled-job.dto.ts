import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  IsCronSchedule,
  IsIanaTimezone,
} from '../validators/schedule.validators';

export const CRON_CONCURRENCY_POLICIES = [
  'Allow',
  'Forbid',
  'Replace',
] as const;
export type CronConcurrencyPolicyDto =
  (typeof CRON_CONCURRENCY_POLICIES)[number];

export class CreateScheduledJobDto {
  @ApiProperty({
    description:
      'Logical job name, unique per application. Lowercase alphanumeric and dashes.',
    example: 'nightly-cleanup',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  @Matches(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, {
    message:
      'name must be lowercase alphanumeric or dashes, and start/end with an alphanumeric',
  })
  name!: string;

  @ApiProperty({
    description: 'Standard cron expression (5 fields).',
    example: '0 3 * * *',
  })
  @IsCronSchedule()
  schedule!: string;

  @ApiProperty({
    description: 'Shell command executed by the job (via /bin/sh -c).',
    example: 'node dist/tasks/cleanup.js',
  })
  @IsString()
  @MinLength(1)
  command!: string;

  @ApiPropertyOptional({
    description:
      'IANA timezone. Defaults to the cluster local time when omitted.',
    example: 'Europe/Rome',
  })
  @IsOptional()
  @IsIanaTimezone()
  timezone?: string;

  @ApiPropertyOptional({
    description:
      'How to handle overlapping runs. Defaults to Forbid (skip a run while the previous is still active).',
    enum: CRON_CONCURRENCY_POLICIES,
    default: 'Forbid',
  })
  @IsOptional()
  @IsIn(CRON_CONCURRENCY_POLICIES)
  concurrencyPolicy?: CronConcurrencyPolicyDto;

  @ApiPropertyOptional({
    description: 'Whether the schedule is active. Defaults to true.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class UpdateScheduledJobDto {
  @ApiPropertyOptional({ description: 'Standard cron expression (5 fields).' })
  @IsOptional()
  @IsCronSchedule()
  schedule?: string;

  @ApiPropertyOptional({ description: 'Shell command executed by the job.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  command?: string;

  @ApiPropertyOptional({ description: 'IANA timezone.' })
  @IsOptional()
  @IsIanaTimezone()
  timezone?: string;

  @ApiPropertyOptional({
    description: 'Overlap handling policy.',
    enum: CRON_CONCURRENCY_POLICIES,
  })
  @IsOptional()
  @IsIn(CRON_CONCURRENCY_POLICIES)
  concurrencyPolicy?: CronConcurrencyPolicyDto;

  @ApiPropertyOptional({ description: 'Enable or suspend the schedule.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class ScheduledJobDto {
  @ApiProperty({ description: 'Logical job name.', example: 'nightly-cleanup' })
  name!: string;

  @ApiProperty({
    description: 'Underlying CronJob resource name (`<slug>-<name>`).',
  })
  resourceName!: string;

  @ApiProperty({ example: '0 3 * * *' })
  schedule!: string;

  @ApiProperty({ example: 'node dist/tasks/cleanup.js' })
  command!: string;

  @ApiPropertyOptional({ example: 'Europe/Rome' })
  timezone?: string;

  @ApiProperty({ enum: CRON_CONCURRENCY_POLICIES })
  concurrencyPolicy!: CronConcurrencyPolicyDto;

  @ApiProperty({ description: 'False when the schedule is suspended.' })
  enabled!: boolean;

  @ApiProperty({
    description: 'Number of currently running jobs for this schedule.',
  })
  activeRuns!: number;

  @ApiPropertyOptional({
    description: 'Last time the controller scheduled a run.',
  })
  lastScheduleTime?: string | null;

  @ApiPropertyOptional({
    description: 'Last time a run of this schedule succeeded.',
  })
  lastSuccessfulTime?: string | null;

  @ApiPropertyOptional({ description: 'CronJob creation timestamp.' })
  createdAt?: string | null;

  @ApiPropertyOptional({ enum: ['Succeeded', 'Failed'], nullable: true })
  lastRunStatus?: 'Running' | 'Succeeded' | 'Failed' | 'Unknown' | null;

  @ApiPropertyOptional({ description: 'Failed runs in a row, newest first.' })
  consecutiveFailures?: number;

  @ApiPropertyOptional({
    description: 'True after 3 failed runs in a row.',
  })
  failing?: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    enum: ['user', 'manifest'],
    description:
      'Who owns it: a person, or the application flui.yaml (read-only here).',
  })
  origin?: 'user' | 'manifest';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'False while the cluster does not have it yet; the next release or a run puts it back.',
  })
  onCluster?: boolean;
}

export type ScheduledJobRunStatus =
  | 'Running'
  | 'Succeeded'
  | 'Failed'
  | 'Unknown';

export class ScheduledJobRunDto {
  @ApiProperty({ description: 'The Job resource name for this run.' })
  jobName!: string;

  @ApiProperty({ enum: ['Running', 'Succeeded', 'Failed', 'Unknown'] })
  status!: ScheduledJobRunStatus;

  @ApiProperty({ description: 'Whether this run was manually triggered.' })
  manual!: boolean;

  @ApiPropertyOptional()
  startTime?: string | null;

  @ApiPropertyOptional()
  completionTime?: string | null;

  @ApiPropertyOptional({
    description:
      'Why a failed run failed, in plain words, when the cluster still says.',
  })
  reason?: string | null;
}

export class TriggerScheduledJobResponseDto {
  @ApiProperty({
    description: 'The Job resource name created for this manual run.',
  })
  jobName!: string;
}

export class ScheduledJobRunLogsDto {
  @ApiProperty()
  jobName!: string;

  @ApiProperty({ description: 'Output of the run (empty when there is none).' })
  logs!: string;

  @ApiPropertyOptional({ description: 'Why the run failed, when it did.' })
  reason?: string | null;
}
