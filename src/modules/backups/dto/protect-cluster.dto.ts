import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';

export class ProtectClusterDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'Registered destination every policy writes to.',
  })
  @IsUUID()
  destinationId: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'A second destination volume backups are copied to after each run. Databases write to the primary only.',
  })
  @IsOptional()
  @IsUUID()
  replicaDestinationId?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'One cron schedule (UTC) for every policy. Omit it to use the default of each kind of backup, spread across the night.',
  })
  @IsOptional()
  @IsString()
  cronSchedule?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @IsInt()
  @Min(1)
  retentionDays?: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    default: false,
    description:
      'Before each deploy, record a restore point for databases and start a copy of the other volumes.',
  })
  @IsOptional()
  @IsBoolean()
  beforeDeploy?: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    default: true,
    description: 'Take the first volume backup of each application now.',
  })
  @IsOptional()
  @IsBoolean()
  runFirstBackup?: boolean;
}
