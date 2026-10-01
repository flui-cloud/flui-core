import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional } from 'class-validator';

export class SetBeforeDeployDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Take a backup before each deploy: a restore point for a continuous database, a dump for one kept by dumps, and a copy of the other volumes. Only the restore point is waited for.',
  })
  @IsBoolean()
  enabled: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    default: false,
    description:
      'Fail the deploy when the backup before it cannot be taken. Off, the deploy goes ahead and the failure is logged.',
  })
  @IsOptional()
  @IsBoolean()
  required?: boolean;
}
