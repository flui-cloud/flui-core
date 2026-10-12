import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { FullCutoverMode, FullStagingMode } from '../enums/full-migration.enum';

export class CreateFullMigrationDto {
  @ApiProperty({ description: 'The consumer application to move.' })
  @IsUUID()
  appId: string;

  @ApiProperty({
    description: 'The source managed-Postgres application whose data migrates.',
  })
  @IsUUID()
  dbAppId: string;

  @ApiProperty({ description: 'Cluster both legs migrate to.' })
  @IsUUID()
  targetClusterId: string;

  @ApiPropertyOptional({
    enum: FullCutoverMode,
    default: FullCutoverMode.AUTO,
    description:
      'manual parks at READY (DB synced + app staged) until the cutover endpoint is called.',
  })
  @IsOptional()
  @IsEnum(FullCutoverMode)
  cutover?: FullCutoverMode;

  @ApiPropertyOptional({
    enum: FullStagingMode,
    default: FullStagingMode.SCALED_DOWN,
    description:
      'live-fenced stages the app at full replicas against the destination DB while it is ' +
      'read-only: the app must boot and pass readiness against a read-only database ' +
      '(no write-migrations-on-start), and must not run background workers/schedulers with ' +
      'external side-effects (queue consumers, cron, outbound webhooks/email) while staged — ' +
      'only its DB writes are fenced (SQLSTATE 25006), external effects are not. Writes fail ' +
      'until cutover. Shrinks the write pause by moving image-pull + boot off the cutover critical path.',
  })
  @IsOptional()
  @IsEnum(FullStagingMode)
  stagingMode?: FullStagingMode;

  @ApiPropertyOptional({
    description:
      'Backup destination the application volumes move through. Defaults to the one protecting the application, or to your only one.',
  })
  @IsOptional()
  @IsUUID()
  backupDestinationId?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 60,
    default: 5,
    description:
      'With a pooled database: how long, in seconds, the cutover lets transactions in flight finish while both poolers hold new requests. A transaction still open then is cut and its client reconnects into the queue.',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  pauseDeadlineSeconds?: number;
}

export class FullMigrationCutoverDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 60,
    description:
      'With a pooled database: the pause deadline in seconds for this cutover, replacing the one given at create.',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  pauseDeadlineSeconds?: number;
}
