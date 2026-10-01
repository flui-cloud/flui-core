import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { BackupScopeSelectorDto } from './selector.dto';
import { BackupScope } from '../enums/backup-scope.enum';
import { BackupPolicyProfile } from '../enums/backup-policy-status.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { DestinationRole } from '../enums/destination-role.enum';

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

/** What a person may set on a policy; anything else in `metadata` is Flui's. */
export class BackupPolicyOptionsDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    type: [String],
    description: 'Volume copies: volume names to leave out.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  excludeVolumes?: string[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'Volume copies: stop the application for the length of each copy, so ' +
      'it is taken at rest. The run records how long it was stopped.',
  })
  @IsOptional()
  @IsBoolean()
  pauseDuringCopy?: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'Volume copies: keep three monthly snapshots on top of seven daily and four weekly (about 30% more space for two more months of history).',
  })
  @IsOptional()
  @IsBoolean()
  keepMonthly?: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'Continuous Postgres: the longest a quiet database waits before closing its current log segment, in seconds (60 to 3600, default 300). Lower means less data at risk if the volume is lost, higher means less storage.',
  })
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(3600)
  archiveTimeoutSeconds?: number;
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
    description:
      'What protects the scope. Omitted, a policy naming one application copies its volumes; any other scope must name it.',
  })
  @IsOptional()
  @IsEnum(BackupEngineClass)
  engineClass?: BackupEngineClass;

  @ApiPropertyOptional({ type: BackupScopeSelectorDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BackupScopeSelectorDto)
  scopeSelector?: BackupScopeSelectorDto;

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

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({ type: BackupPolicyOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => BackupPolicyOptionsDto)
  metadata?: BackupPolicyOptionsDto;
}
