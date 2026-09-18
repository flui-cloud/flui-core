import { Controller, Get, Param, Query, Logger } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { ClusterHealthService } from '../services';
import {
  ClusterHealthResponseDto,
  ClusterHealthHistoryResponseDto,
  ClusterHealthHistoryQueryDto,
} from '../dto';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { SECTION } from '../../iam/constants/iam-sections';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

/**
 * Cluster Health Controller
 *
 * Provides instant and historical health status for clusters
 * based on Prometheus up{} metric.
 */
@ApiTags('Cluster Health')
@ApiBearerAuth()
// Whole-installation data: the nodes of a cluster, their metrics and their
// logs, none of it scoped to a tenant. It answered to every authenticated
// principal. The section is the human gate; the permission is what the
// credential ceiling is checked against, and without it an agent key minted by
// an administrator reaches these regardless of the scope it declares.
@RequireSection(SECTION.CLUSTERS)
@RequirePermission(IAM_PERMISSION.CLUSTER_READ)
@Controller('observability')
export class ClusterHealthController {
  private readonly logger = new Logger(ClusterHealthController.name);

  constructor(private readonly clusterHealth: ClusterHealthService) {}

  /**
   * Get current health status for a cluster or a specific server
   */
  @Get('clusters/:clusterId/health')
  @ApiOperation({
    summary: 'Get cluster health status',
    description:
      'Returns the current health status of all targets in a cluster based on the Prometheus up{} metric. Use serverId query param to check a specific server.',
  })
  @ApiParam({
    name: 'clusterId',
    description: 'Cluster ID (GUID)',
    required: true,
  })
  @ApiQuery({
    name: 'serverId',
    description: 'Optional server ID to check health for a specific server',
    required: false,
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: 'Current cluster health status',
    type: ClusterHealthResponseDto,
  })
  async getClusterHealth(
    @Param('clusterId') clusterId: string,
    @Query('serverId') serverId?: string,
  ): Promise<ClusterHealthResponseDto> {
    const serverPart = serverId ? `, server: ${serverId}` : '';
    this.logger.debug(`Health check for cluster: ${clusterId}${serverPart}`);

    return this.clusterHealth.getInstantHealth(clusterId, serverId);
  }

  /**
   * Get historical health status over a time range
   */
  @Get('clusters/:clusterId/health/history')
  @ApiOperation({
    summary: 'Get cluster health history',
    description:
      'Returns historical up/down status for all targets in a cluster over a given time range. The frontend can pass any range (last hour, last day, last week) and a step resolution.',
  })
  @ApiParam({
    name: 'clusterId',
    description: 'Cluster ID (GUID)',
    required: true,
  })
  @ApiQuery({
    name: 'serverId',
    description:
      'Optional server ID to filter health history for a specific server',
    required: false,
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: 'Historical cluster health data',
    type: ClusterHealthHistoryResponseDto,
  })
  async getClusterHealthHistory(
    @Param('clusterId') clusterId: string,
    @Query() query: ClusterHealthHistoryQueryDto,
    @Query('serverId') serverId?: string,
  ): Promise<ClusterHealthHistoryResponseDto> {
    const serverPart = serverId ? `, server: ${serverId}` : '';
    this.logger.debug(
      `Health history for cluster: ${clusterId}${serverPart}, range: ${query.start} to ${query.end}, step: ${query.step}`,
    );

    return this.clusterHealth.getHealthHistory(
      clusterId,
      query.start,
      query.end,
      query.step,
      serverId,
    );
  }
}
