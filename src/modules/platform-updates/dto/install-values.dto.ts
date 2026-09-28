import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, IsUUID } from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class PlanInstallValuesDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'The cluster whose master to reconstruct. Omitted means the control cluster.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  clusterId?: string;
}

export class ApplyInstallValuesDto extends PlanInstallValuesDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'The plan id the dry run returned.' })
  @IsString()
  @IsNotEmpty()
  planId: string;
}
