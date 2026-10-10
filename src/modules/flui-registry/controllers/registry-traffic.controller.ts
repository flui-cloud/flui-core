import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { RegistryTrafficDto } from '../dto/registry-traffic.dto';
import {
  REGISTRY_TRAFFIC_WINDOWS,
  RegistryTrafficService,
} from '../services/registry-traffic.service';

/**
 * Totals for the whole installation, naming no application, so reading them
 * asks only what reading the clusters asks.
 */
@ApiTags('Registry')
@ApiBearerAuth()
@RequirePermission(IAM_PERMISSION.CLUSTER_READ)
@Controller('registry/traffic')
export class RegistryTrafficController {
  constructor(private readonly traffic: RegistryTrafficService) {}

  @Get()
  @ApiOperation({
    summary:
      'What the instance registry carried: pulls and pushes, refusals and failures, bytes in and out, and the busiest five minutes',
  })
  @ApiQuery({ name: 'window', required: false, enum: REGISTRY_TRAFFIC_WINDOWS })
  async read(@Query('window') window?: string): Promise<RegistryTrafficDto> {
    return this.traffic.traffic(window ?? '24h');
  }
}
