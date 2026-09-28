import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class StartPlatformUpdateDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'The release to move to. Must match the one currently on offer — a mismatch is refused rather than resolved, so nobody applies a release they did not read about.',
    example: '0.14.0',
  })
  @IsString()
  @IsNotEmpty()
  targetVersion: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'The plan id `POST /platform/updates/plan` returned. With it, the whole update runs: backup, manifests, images, K3s and checks, and only as planned. Without it, only a release that moves nothing but images is applied, the way it always was.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  planId?: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'Skip the platform backup the update takes first. Needs `acknowledgement`; recorded in the operation and in the audit log.',
  })
  @IsOptional()
  @IsBoolean()
  withoutBackup?: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'With `withoutBackup`, exactly: "Without a backup, a database migration cannot be undone."',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  acknowledgement?: string;
}

export class PlanPlatformUpgradeDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description: 'The release to plan for. Omitted means the one on offer.',
    example: '0.14.0',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  targetVersion?: string;
}
