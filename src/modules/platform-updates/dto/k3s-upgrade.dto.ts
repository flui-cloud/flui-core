import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class K3sUpgradePlanQueryDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiPropertyOptional({
    description:
      'The cluster to plan for. Omitted means every ready cluster, workload clusters first and the control last.',
    format: 'uuid',
  })
  @IsOptional()
  @IsUUID()
  clusterId?: string;
}
