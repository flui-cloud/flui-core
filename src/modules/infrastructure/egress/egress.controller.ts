import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import {
  AppAccessGuard,
  AppAction,
} from '../../applications/guards/app-access.guard';
import { EgressPolicyService } from './egress-policy.service';
import {
  EgressPolicyChangeDto,
  EgressPolicyDto,
  SetEgressPolicyDto,
} from './egress.dto';

@ApiTags('Egress')
@ApiBearerAuth()
@Controller('infrastructure/clusters/:id/egress-policy')
export class ClusterEgressController {
  constructor(private readonly egress: EgressPolicyService) {}

  @Get()
  @RequireSection('clusters')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'Which ports applications on a cluster may reach outside it',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: EgressPolicyDto })
  get(@Param('id') id: string): Promise<EgressPolicyDto> {
    return this.egress.view(id);
  }

  @Put()
  @RequireSection('infrastructure')
  @RequirePermission(IAM_PERMISSION.EGRESS_MANAGE)
  @ApiOperation({
    summary:
      'Allow applications on a cluster to reach the outside only on these ports',
    description:
      'Applies to every application that is not part of the platform, whoever owns it. Traffic inside the cluster is never restricted.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: EgressPolicyChangeDto })
  set(
    @Param('id') id: string,
    @Body() dto: SetEgressPolicyDto,
  ): Promise<EgressPolicyChangeDto> {
    return this.egress.change(id, dto.ports);
  }

  @Delete()
  @RequireSection('infrastructure')
  @RequirePermission(IAM_PERMISSION.EGRESS_MANAGE)
  @ApiOperation({
    summary: 'Remove the rule: applications may reach the outside on any port',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: EgressPolicyChangeDto })
  clear(@Param('id') id: string): Promise<EgressPolicyChangeDto> {
    return this.egress.change(id, null);
  }
}

@ApiTags('Egress')
@ApiBearerAuth()
@UseGuards(AppAccessGuard)
@Controller('applications/:appId')
export class AppEgressController {
  constructor(private readonly egress: EgressPolicyService) {}

  @Get('egress')
  @AppAction(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'Which ports this application may reach outside its cluster',
    description:
      'Set by an administrator for the whole cluster; ask them to open another port.',
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiResponse({ status: 200, type: EgressPolicyDto })
  get(@Param('appId') appId: string): Promise<EgressPolicyDto> {
    return this.egress.viewForApplication(appId);
  }
}
