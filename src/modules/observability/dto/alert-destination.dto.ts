import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export const ALERT_DESTINATION_KINDS = ['email', 'webhook'] as const;
export const ALERT_SEVERITY_FLOORS = ['warning', 'critical'] as const;
export const ALERT_DESTINATION_SCOPES = ['infrastructure', 'all'] as const;

const SCOPE_DESCRIPTION =
  '`infrastructure`: only alerts no application owns (nodes, disks, certificates, platform backups). `all`: every application’s alerts too, which needs the data:access permission.';

export class CreateAlertDestinationDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ALERT_DESTINATION_KINDS })
  @IsIn(ALERT_DESTINATION_KINDS)
  kind: 'email' | 'webhook';

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty({
    description:
      'An email address, or the https address a signed JSON POST is sent to.',
    example: 'https://hooks.example.com/flui',
  })
  @IsString()
  @MaxLength(2048)
  target: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    enum: ALERT_SEVERITY_FLOORS,
    default: 'critical',
    description: 'The least severe alert this destination receives.',
  })
  @IsOptional()
  @IsIn(ALERT_SEVERITY_FLOORS)
  minSeverity?: 'warning' | 'critical';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    enum: ALERT_DESTINATION_SCOPES,
    default: 'infrastructure',
    description: SCOPE_DESCRIPTION,
  })
  @IsOptional()
  @IsIn(ALERT_DESTINATION_SCOPES)
  scope?: 'infrastructure' | 'all';
}

export class UpdateAlertDestinationDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ enum: ALERT_SEVERITY_FLOORS })
  @IsOptional()
  @IsIn(ALERT_SEVERITY_FLOORS)
  minSeverity?: 'warning' | 'critical';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    enum: ALERT_DESTINATION_SCOPES,
    description: SCOPE_DESCRIPTION,
  })
  @IsOptional()
  @IsIn(ALERT_DESTINATION_SCOPES)
  scope?: 'infrastructure' | 'all';
}

export class AlertDestinationDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  id: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ALERT_DESTINATION_KINDS })
  kind: 'email' | 'webhook';

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  target: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ALERT_SEVERITY_FLOORS })
  minSeverity: 'warning' | 'critical';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: ALERT_DESTINATION_SCOPES,
    description: SCOPE_DESCRIPTION,
  })
  scope: 'infrastructure' | 'all';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  enabled: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Whether deliveries are signed. The secret itself is shown once, when the destination is added.',
  })
  signed: boolean;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiPropertyOptional({ type: String, nullable: true })
  createdBy: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  createdAt: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ type: String, nullable: true })
  lastDeliveryAt: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'The HTTP status a webhook answered, `sent` for an email, or `failed`.',
  })
  lastStatus: string | null;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({ type: String, nullable: true })
  lastError: string | null;
}

export class CreatedAlertDestinationDto extends AlertDestinationDto {
  @Sensitivity(Sensitivity.CREDENTIAL, { conditional: true })
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Webhooks only: the key that signs every delivery. Returned now and never again. ' +
      'To verify a delivery, the receiver computes HMAC-SHA256 with this key over `<X-Flui-Timestamp>.<body>`, using the raw request body bytes exactly as received (not a re-serialised JSON), ' +
      'and compares `sha256=<hex digest>` with the X-Flui-Signature header in constant time (e.g. crypto.timingSafeEqual, hmac.compare_digest). ' +
      'It rejects the delivery when |now - X-Flui-Timestamp| is more than 300 seconds, and may drop a repeated X-Flui-Delivery id (a UUID unique to each delivery) as a replay.',
  })
  secret: string | null;
}

export class AlertDestinationTestResultDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  ok: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ type: String, nullable: true })
  status: string | null;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiPropertyOptional({ type: String, nullable: true })
  error: string | null;
}

export class AdminAlertRoutingDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Email administrators warnings about what no application owns (nodes, disks, certificates), not only critical alerts. Off unless switched on.',
  })
  @IsBoolean()
  warnings: boolean;
}
