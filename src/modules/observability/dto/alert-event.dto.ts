import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

export class AlertEventDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ enum: ['firing', 'resolved'] })
  status: string;

  @ApiPropertyOptional({
    enum: ['alertmanager', 'timeout'],
    description:
      'How the alert was closed. `timeout` means it stopped repeating without a ' +
      'resolve notification, so the end time is when it was last seen, not when it ' +
      'actually recovered.',
  })
  resolved_by?: string | null;

  @ApiProperty()
  alertname: string;

  @ApiProperty()
  severity: string;

  @ApiPropertyOptional()
  flui_kind?: string | null;

  @ApiProperty()
  summary: string;

  @ApiPropertyOptional()
  description?: string | null;

  @ApiPropertyOptional()
  application_id?: string | null;

  @ApiPropertyOptional()
  application_slug?: string | null;

  @ApiPropertyOptional()
  namespace?: string | null;

  @ApiPropertyOptional()
  cluster_id?: string | null;

  @ApiPropertyOptional()
  node_instance?: string | null;

  @ApiProperty()
  starts_at: string;

  @ApiPropertyOptional()
  ends_at?: string | null;

  @ApiProperty()
  last_seen_at: string;
}

export class AlertEventsResponseDto {
  @ApiProperty({ type: [AlertEventDto] })
  alerts: AlertEventDto[];

  @ApiProperty({
    description: 'How many of the returned alerts are still firing',
  })
  firing: number;

  @ApiProperty()
  queried_at: string;
}

export class AlertEventsQueryDto {
  @ApiPropertyOptional({
    enum: ['firing', 'resolved'],
    description: 'Omit to get both, newest first.',
  })
  @IsOptional()
  @IsIn(['firing', 'resolved'])
  status?: 'firing' | 'resolved';

  @ApiPropertyOptional({ minimum: 1, maximum: 200, default: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}
