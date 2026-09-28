import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { SECTION } from '../../iam/constants/iam-sections';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { K3sUpgradeService } from '../services/k3s-upgrade.service';
import { K3sUpgradePlan } from '../interfaces/k3s-upgrade.interface';
import { K3sUpgradePlanQueryDto } from '../dto/k3s-upgrade.dto';

@ApiTags('Platform Updates')
@ApiBearerAuth()
@Controller('platform/updates/k3s')
@RequireSection(SECTION.INFRASTRUCTURE)
export class K3sUpgradeController {
  constructor(private readonly k3s: K3sUpgradeService) {}

  @Get('plan')
  @RequirePermission(IAM_PERMISSION.PLATFORM_UPDATE)
  @ApiOperation({
    summary: 'What upgrading K3s to this release would do, per cluster',
    description:
      'Reads each cluster’s nodes and reports the K3s versions it would pass through, one minor version at a time, and what stops it: a node that is not Ready, a missing upgrade controller, or a minor version no published release ships. Changes nothing.',
  })
  plan(@Query() query: K3sUpgradePlanQueryDto): Promise<K3sUpgradePlan[]> {
    return this.k3s.plan(query.clusterId);
  }
}
