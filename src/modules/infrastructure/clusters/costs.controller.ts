import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { CostsService, MAX_COST_MONTHS } from './services/costs.service';
import { CostsResponseDto } from './dto/costs.dto';

/**
 * What the installation's machines cost, across every cluster and provider,
 * including clusters already deleted. The `infrastructure` section because it
 * answers for the whole instance, not for one tenant's clusters.
 */
@ApiTags('Infrastructure - Costs')
@ApiBearerAuth()
@Controller('infrastructure/costs')
export class CostsController {
  constructor(private readonly costs: CostsService) {}

  @Get()
  @RequireSection('infrastructure')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'Spent and forecast, month by month, provider by provider',
    description:
      'Built from the recorded lifetimes of every machine and volume, deleted clusters included. ' +
      'The current month carries a forecast: what was spent plus what runs now kept running until the month ends. ' +
      'Amounts exclude VAT; gross amounts are given only where the provider states the VAT rate of the account.',
  })
  @ApiQuery({
    name: 'months',
    required: false,
    description: `How many calendar months, ending with the current one: 1-${MAX_COST_MONTHS}, default 6`,
  })
  @ApiResponse({ status: 200, type: CostsResponseDto })
  async list(@Query('months') months?: string): Promise<CostsResponseDto> {
    const parsed = months ? Number.parseInt(months, 10) : undefined;
    return this.costs.getCosts({
      months: Number.isFinite(parsed) ? parsed : undefined,
    });
  }
}
