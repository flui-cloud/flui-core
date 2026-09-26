import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import {
  AppAccessGuard,
  AppAction,
} from '../../applications/guards/app-access.guard';
import { byOf } from '../scaling/scaling-actor';
import { MaintenanceService } from './maintenance.service';
import {
  AppMaintenanceDto,
  ClusterMaintenanceDto,
  DeferredActionDto,
  MaintenanceWindowDto,
  SetAppMaintenanceDto,
} from './maintenance.dto';

@ApiTags('Maintenance windows')
@ApiBearerAuth()
@Controller()
export class ClusterMaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Get('infrastructure/clusters/:id/maintenance-window')
  @RequireSection('clusters')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: "A cluster's maintenance window, and when it next opens",
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: ClusterMaintenanceDto })
  get(@Param('id') id: string): Promise<ClusterMaintenanceDto> {
    return this.maintenance.clusterWindow(id);
  }

  @Put('infrastructure/clusters/:id/maintenance-window')
  @RequireSection('infrastructure')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ActionCycle({
    action: 'PUT /infrastructure/clusters/:id/maintenance-window',
    bind: ['id'],
    sentence: 'set the maintenance window of cluster {id}',
    consequence:
      'Changes held for the window run when it opens; the cluster itself is not restarted by this.',
  })
  @ApiOperation({
    summary: "Set a cluster's maintenance window",
    description:
      'Weekly slots in one time zone. Changes a person holds "for the next window" run at the next opening; applications follow it unless they set their own.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: ClusterMaintenanceDto })
  set(
    @Param('id') id: string,
    @Body() dto: MaintenanceWindowDto,
  ): Promise<ClusterMaintenanceDto> {
    return this.maintenance.setClusterWindow(id, dto);
  }

  @Delete('infrastructure/clusters/:id/maintenance-window')
  @RequireSection('infrastructure')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ActionCycle({
    action: 'DELETE /infrastructure/clusters/:id/maintenance-window',
    bind: ['id'],
    sentence: 'remove the maintenance window of cluster {id}',
    consequence:
      'Changes already held keep their time; new ones can only be applied at once.',
  })
  @ApiOperation({ summary: "Remove a cluster's maintenance window" })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiResponse({ status: 200, type: ClusterMaintenanceDto })
  clear(@Param('id') id: string): Promise<ClusterMaintenanceDto> {
    return this.maintenance.clearClusterWindow(id);
  }

  @Get('infrastructure/clusters/:id/deferred-actions')
  @RequireSection('clusters')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary:
      'Changes held for the maintenance window on a cluster, and what became of them',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  @ApiQuery({
    name: 'pending',
    required: false,
    description: 'true: only those still waiting',
  })
  @ApiResponse({ status: 200, type: [DeferredActionDto] })
  list(
    @Param('id') id: string,
    @Query('pending') pending?: string,
  ): Promise<DeferredActionDto[]> {
    return this.maintenance.list({
      clusterId: id,
      pendingOnly: pending === 'true',
    });
  }
}

@ApiTags('Maintenance windows')
@ApiBearerAuth()
@UseGuards(AppAccessGuard)
@Controller('applications/:appId')
export class AppMaintenanceController {
  constructor(private readonly maintenance: MaintenanceService) {}

  @Get('maintenance')
  @AppAction(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary:
      'Which maintenance window governs an application, and when it next opens',
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiResponse({ status: 200, type: AppMaintenanceDto })
  get(@Param('appId') appId: string): Promise<AppMaintenanceDto> {
    return this.maintenance.appMaintenance(appId);
  }

  @Put('maintenance')
  @AppAction(IAM_PERMISSION.APP_WRITE)
  @ApiOperation({
    summary:
      "Follow the cluster's window, keep one of its own, or take changes at any time",
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiResponse({ status: 200, type: AppMaintenanceDto })
  set(
    @Param('appId') appId: string,
    @Body() dto: SetAppMaintenanceDto,
  ): Promise<AppMaintenanceDto> {
    return this.maintenance.setAppMaintenance(appId, dto);
  }

  @Get('deferred-actions')
  @AppAction(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'Changes held for the maintenance window on an application',
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiResponse({ status: 200, type: [DeferredActionDto] })
  list(@Param('appId') appId: string): Promise<DeferredActionDto[]> {
    return this.maintenance.list({ applicationId: appId });
  }

  @Delete('deferred-actions/:actionId')
  @AppAction(IAM_PERMISSION.APP_WRITE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Cancel a change held for the maintenance window, before it runs',
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiParam({ name: 'actionId', description: 'Deferred action ID' })
  @ApiResponse({ status: 200, type: DeferredActionDto })
  async cancel(
    @Param('appId') appId: string,
    @Param('actionId') actionId: string,
    @Req() req: Record<string, unknown>,
  ): Promise<DeferredActionDto> {
    const row = await this.maintenance.get(actionId);
    if (row.applicationId !== appId) {
      throw new NotFoundException(`Deferred action ${actionId} not found`);
    }
    return this.maintenance.cancel(actionId, byOf(req));
  }
}
