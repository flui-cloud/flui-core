import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Length,
} from 'class-validator';
import { DbCutoverMode, DbMigrationMode } from '../enums/db-migration.enum';

export class CreateDbMigrationDto {
  @ApiProperty({ description: 'Source database application id.' })
  @IsUUID()
  srcAppId: string;

  @ApiProperty({ description: 'Cluster the database migrates to.' })
  @IsUUID()
  targetClusterId: string;

  @ApiPropertyOptional({
    description:
      'Display name for the new install (defaults to a derived one).',
  })
  @IsOptional()
  @IsString()
  @Length(1, 120)
  displayName?: string;

  @ApiPropertyOptional({
    enum: DbMigrationMode,
    default: DbMigrationMode.LIVE,
    description:
      'live = replication + fenced cutover (source alive); restore = PITR from the backup repo (DR).',
  })
  @IsOptional()
  @IsEnum(DbMigrationMode)
  mode?: DbMigrationMode;

  @ApiPropertyOptional({
    enum: DbCutoverMode,
    default: DbCutoverMode.AUTO,
    description:
      'manual parks the migration at SYNCED until the cutover endpoint is called.',
  })
  @IsOptional()
  @IsEnum(DbCutoverMode)
  cutover?: DbCutoverMode;

  @ApiPropertyOptional({
    default: true,
    description:
      'Exact per-table count(*) comparison during cutover; disable for very large databases.',
  })
  @IsOptional()
  @IsBoolean()
  verifyRowCounts?: boolean;

  @ApiPropertyOptional({
    description: 'restore mode only: ISO-8601 instant to recover to.',
  })
  @IsOptional()
  @IsISO8601()
  recoveryTargetTime?: string;
}
