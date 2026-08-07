import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsObject, IsOptional, IsString } from 'class-validator';

export class AlertmanagerAlertDto {
  @ApiProperty({ example: 'firing', enum: ['firing', 'resolved'] })
  @IsString()
  status: string;

  @ApiProperty({
    example: {
      alertname: 'FluiAppDown',
      severity: 'critical',
      flui_kind: 'application',
      namespace: 'default',
      label_app_kubernetes_io_name: 'vops-api-c9a2jp',
    },
    description: 'Alert labels as evaluated by vmalert',
  })
  @IsObject()
  labels: Record<string, string>;

  @ApiPropertyOptional({
    example: { summary: 'Application vops-api is down' },
  })
  @IsOptional()
  @IsObject()
  annotations?: Record<string, string>;

  @ApiPropertyOptional({ example: '2026-07-18T09:00:00.000Z' })
  @IsOptional()
  @IsString()
  startsAt?: string;

  @ApiPropertyOptional({ example: '0001-01-01T00:00:00Z' })
  @IsOptional()
  @IsString()
  endsAt?: string;

  @ApiPropertyOptional({ example: 'a1b2c3d4e5f6' })
  @IsOptional()
  @IsString()
  fingerprint?: string;
}

export class AlertmanagerWebhookDto {
  @ApiPropertyOptional({ example: '4' })
  @IsOptional()
  @IsString()
  version?: string;

  @ApiPropertyOptional({ example: '{}:{alertname="FluiAppDown"}' })
  @IsOptional()
  @IsString()
  groupKey?: string;

  @ApiProperty({ example: 'firing', enum: ['firing', 'resolved'] })
  @IsString()
  status: string;

  @ApiPropertyOptional({ example: 'flui-api' })
  @IsOptional()
  @IsString()
  receiver?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  groupLabels?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  commonLabels?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  commonAnnotations?: Record<string, string>;

  @ApiProperty({ type: [AlertmanagerAlertDto] })
  @IsArray()
  alerts: AlertmanagerAlertDto[];
}

export class AlertsWebhookResultDto {
  @ApiProperty({ example: true })
  received: boolean;

  @ApiProperty({ example: 3, description: 'Alerts in the delivered group' })
  alerts: number;

  @ApiProperty({
    example: 2,
    description: 'Alerts whose subject was resolved to a Flui application',
  })
  resolved: number;
}
