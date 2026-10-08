import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { AppCutoverMode } from '../enums/app-migration.enum';

export class CreateAppMigrationDto {
  @ApiProperty({ description: 'Application to move.' })
  @IsUUID()
  srcAppId: string;

  @ApiProperty({ description: 'Cluster the application migrates to.' })
  @IsUUID()
  targetClusterId: string;

  @ApiPropertyOptional({
    enum: AppCutoverMode,
    default: AppCutoverMode.AUTO,
    description:
      'manual parks the migration at READY (workload up on the destination) until the cutover endpoint is called.',
  })
  @IsOptional()
  @IsEnum(AppCutoverMode)
  cutover?: AppCutoverMode;

  @ApiPropertyOptional({
    description:
      'Backup destination the volumes move through. Defaults to the one protecting the application, or to your only one.',
  })
  @IsOptional()
  @IsUUID()
  backupDestinationId?: string;
}
