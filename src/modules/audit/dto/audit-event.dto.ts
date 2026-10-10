import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class ListAuditEventsQueryDto {
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsISO8601()
  since?: string;

  @IsOptional()
  @IsISO8601()
  until?: string;

  @IsOptional()
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  dataAccess?: boolean;

  @IsOptional()
  @IsIn(['ok', 'refused', 'failed'])
  outcome?: 'ok' | 'refused' | 'failed';

  @ApiPropertyOptional({
    description:
      'Id of the last record already seen: returns the records older than it.',
  })
  @IsOptional()
  @IsUUID()
  before?: string;

  @IsOptional()
  @Transform(({ value }) => Number(value))
  @IsInt()
  @Min(1)
  @Max(500)
  limit?: number;
}

export class AuditEventResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  id: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  at: Date;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  userId: string | null;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiPropertyOptional({ nullable: true })
  email: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    nullable: true,
    description: 'user, key or agent',
  })
  actorKind: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  actorKeyId: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: 'POST /iam/grants' })
  action: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  target: Record<string, string> | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  status: number | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['ok', 'refused', 'failed'] })
  outcome: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ nullable: true })
  permission: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Whether the action reached application data.' })
  dataAccess: boolean;
}
