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
