import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class CatalogUdpPortsRequestDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Cluster the app would be installed on.' })
  @IsUUID()
  clusterId: string;
}
