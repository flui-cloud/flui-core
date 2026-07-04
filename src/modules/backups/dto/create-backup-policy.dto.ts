import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BackupScope } from '../enums/backup-scope.enum';
import { BackupPolicyProfile } from '../enums/backup-policy-status.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { DestinationRole } from '../enums/destination-role.enum';
import { BackupScopeSelector } from '../entities/backup-policy.entity';

export class PolicyDestinationInputDto {
  @ApiProperty()
  @IsUUID()
  destinationId: string;

  @ApiProperty({ enum: DestinationRole })
  @IsEnum(DestinationRole)
  role: DestinationRole;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  priority?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  retentionDaysOverride?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  retentionMaxCopiesOverride?: number;
}

export class CreateBackupPolicyDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiProperty()
  @IsUUID()
  clusterId: string;

  @ApiProperty({ enum: BackupScope })
  @IsEnum(BackupScope)
  scope: BackupScope;

  @ApiPropertyOptional({
    enum: BackupEngineClass,
    default: BackupEngineClass.VOLUME,
  })
  @IsOptional()
  @IsEnum(BackupEngineClass)
  engineClass?: BackupEngineClass;

  @ApiPropertyOptional()
  @IsOptional()
  scopeSelector?: BackupScopeSelector;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includePvcs?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  includeEtcdL1?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cronSchedule?: string;

  @ApiPropertyOptional({ default: 30 })
  @IsOptional()
  @IsInt()
  @Min(1)
  retentionDays?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  retentionMaxCopies?: number;

  @ApiPropertyOptional({ enum: BackupPolicyProfile })
  @IsOptional()
  @IsEnum(BackupPolicyProfile)
  profile?: BackupPolicyProfile;

  @ApiProperty({ type: [PolicyDestinationInputDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PolicyDestinationInputDto)
  destinations: PolicyDestinationInputDto[];
}
