import {
  Controller,
  Get,
  Param,
  Query,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { PrometheusQueryService, LokiQueryService } from '../services';
import {
  ClusterMetricsResponseDto,
  ClusterMetricsHistoryResponseDto,
  MetricsHistoryQueryDto,
  ServerMetricsDto,
  ServerLogsQueryDto,
  ServerLogsResponseDto,
} from '../dto';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { SECTION } from '../../iam/constants/iam-sections';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

/**
 * Server Metrics Controller
 *
 * Provides unified metrics and logs API for clusters.
 * Query by cluster_id with optional server_id filtering.
 */
@ApiTags('Cluster Metrics & Logs')
@ApiBearerAuth()
// Whole-installation data: the nodes of a cluster, their metrics and their
// logs, none of it scoped to a tenant. It answered to every authenticated
// principal. The section is the human gate; the permission is what the
// credential ceiling is checked against, and without it an agent key minted by
// an administrator reaches these regardless of the scope it declares.
@RequireSection(SECTION.CLUSTERS)
@RequirePermission(IAM_PERMISSION.CLUSTER_READ)
@Controller('observability')
export class ServerMetricsController {
  private readonly logger = new Logger(ServerMetricsController.name);

  constructor(
    private readonly prometheusQuery: PrometheusQueryService,
    private readonly lokiQuery: LokiQueryService,
  ) {}

  /**
   * Get real-time metrics for a cluster or specific server in a cluster
   */
  @Get('clusters/:clusterId/metrics')
  @ApiOperation({
    summary: 'Get cluster metrics',
    description:
      'Returns real-time CPU, memory, disk, and network metrics for entire cluster or specific server. Use serverId query param to filter by server.',
  })
  @ApiParam({
    name: 'clusterId',
    description: 'Cluster ID (GUID)',
    required: true,
  })
  @ApiQuery({
    name: 'serverId',
    description: 'Optional server ID to filter metrics for a specific server',
    required: false,
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: 'Cluster metrics grouped per server',
    type: ClusterMetricsResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'No metrics available',
  })
  async getClusterMetrics(
    @Param('clusterId') clusterId: string,
    @Query('serverId') serverId?: string,
  ): Promise<ClusterMetricsResponseDto> {
    const serverPart = serverId ? `, server: ${serverId}` : '';
    this.logger.debug(
      `Fetching metrics for cluster: ${clusterId}${serverPart}`,
    );

    try {
      const metricsMap = await this.prometheusQuery.getAllServerMetrics(
        clusterId,
        serverId,
      );

      if (metricsMap.size === 0) {
        const serverPart = serverId ? ` server ${serverId}` : '';
        throw new NotFoundException(
          `No metrics found for cluster ${clusterId}${serverPart}. Ensure Node Exporter is running and Prometheus is scraping.`,
        );
      }

      const servers: ServerMetricsDto[] = [];

      for (const [instance, m] of metricsMap) {
        servers.push({
          instance,
          server_id: m.server_id,
          cpu: {
            usage_percent: m.cpu || 0,
            cores: m.cores || undefined,
          },
          memory: {
            total_bytes: m.memory_total || 0,
            used_bytes: m.memory_used || 0,
            available_bytes: m.memory_available || 0,
            usage_percent: m.memory_usage || 0,
          },
          disk: {
            total_bytes: m.disk_total || 0,
            used_bytes: m.disk_used || 0,
            available_bytes: m.disk_available || 0,
            usage_percent: m.disk_usage || 0,
          },
          network: {
            bytes_in: m.bytes_in || undefined,
            bytes_out: m.bytes_out || undefined,
          },
          system:
            m.load && m.uptime !== null
              ? {
                  load: m.load,
                  uptime_seconds: m.uptime,
                }
              : undefined,
        });
      }

      return {
        cluster_id: clusterId,
        timestamp: new Date().toISOString(),
        servers,
      };
    } catch (error) {
      this.logger.error(
        `Failed to fetch metrics for cluster ${clusterId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Get historical metrics for a cluster over a time range (for timeline charts)
   */
  @Get('clusters/:clusterId/metrics/history')
  @ApiOperation({
    summary: 'Get cluster metrics history',
    description:
      'Returns historical CPU, memory, disk, and network metrics for all servers over a given time range. Use serverId to filter a specific server. The frontend controls the range and step resolution.',
  })
  @ApiParam({
    name: 'clusterId',
    description: 'Cluster ID (GUID)',
    required: true,
  })
  @ApiQuery({
    name: 'serverId',
    description:
      'Optional server ID to filter metrics history for a specific server',
    required: false,
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: 'Historical cluster metrics per server',
    type: ClusterMetricsHistoryResponseDto,
  })
  @ApiResponse({
    status: 404,
    description: 'No metrics available for the given range',
  })
  async getClusterMetricsHistory(
    @Param('clusterId') clusterId: string,
    @Query() query: MetricsHistoryQueryDto,
    @Query('serverId') serverId?: string,
  ): Promise<ClusterMetricsHistoryResponseDto> {
    const serverPart2 = serverId ? `, server: ${serverId}` : '';
    this.logger.debug(
      `Fetching metrics history for cluster: ${clusterId}${serverPart2}, range: ${query.start} to ${query.end}, step: ${query.step}`,
    );

    try {
      const startUnix = Math.floor(new Date(query.start).getTime() / 1000);
      const endUnix = Math.floor(new Date(query.end).getTime() / 1000);

      const historyMap = await this.prometheusQuery.getMetricsHistory(
        clusterId,
        startUnix,
        endUnix,
        query.step,
        serverId,
      );

      if (historyMap.size === 0) {
        const serverPart3 = serverId ? ` server ${serverId}` : '';
        throw new NotFoundException(
          `No metrics history found for cluster ${clusterId}${serverPart3} in the given range.`,
        );
      }

      const servers = Array.from(historyMap.entries()).map(
        ([instance, data]) => ({
          instance,
          server_id: data.server_id,
          data_points: data.data_points.map((dp) => ({
            timestamp: dp.timestamp,
            datetime: new Date(dp.timestamp * 1000).toISOString(),
            cpu_percent: dp.cpu_percent,
            memory_percent: dp.memory_percent,
            disk_percent: dp.disk_percent,
            network_in: dp.network_in,
            network_out: dp.network_out,
          })),
        }),
      );

      return {
        cluster_id: clusterId,
        range_start: query.start,
        range_end: query.end,
        step: query.step,
        servers,
        queried_at: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(
        `Failed to fetch metrics history for cluster ${clusterId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Get logs for a cluster or specific server in a cluster
   */
  @Get('clusters/:clusterId/logs')
  @ApiOperation({
    summary: 'Get cluster logs',
    description:
      'Returns logs for entire cluster or specific server with optional filtering. Use serverId query param to filter by server.',
  })
  @ApiParam({
    name: 'clusterId',
    description: 'Cluster ID (GUID)',
    required: true,
  })
  @ApiQuery({
    name: 'serverId',
    description: 'Optional server ID to filter logs for a specific server',
    required: false,
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: 'Cluster logs',
    type: ServerLogsResponseDto,
  })
  async getClusterLogs(
    @Param('clusterId') clusterId: string,
    @Query() query: ServerLogsQueryDto,
    @Query('serverId') serverId?: string,
  ): Promise<ServerLogsResponseDto> {
    const serverPart4 = serverId ? `, server: ${serverId}` : '';
    this.logger.debug(
      `Fetching logs for cluster: ${clusterId}${serverPart4}, tail: ${query.tail}`,
    );

    try {
      return await this.lokiQuery.getServerLogs(
        clusterId,
        serverId,
        query.tail,
        query.component,
        query.search,
        query.start,
        query.end,
      );
    } catch (error) {
      this.logger.error(
        `Failed to fetch logs for cluster ${clusterId}: ${error.message}`,
      );
      throw error;
    }
  }

  /**
   * Get error logs for a cluster or specific server in a cluster
   */
  @Get('clusters/:clusterId/logs/errors')
  @ApiOperation({
    summary: 'Get cluster error logs',
    description:
      'Returns only error logs for entire cluster or specific server. Use serverId query param to filter by server.',
  })
  @ApiParam({
    name: 'clusterId',
    description: 'Cluster ID (GUID)',
    required: true,
  })
  @ApiQuery({
    name: 'serverId',
    description:
      'Optional server ID to filter error logs for a specific server',
    required: false,
    type: String,
  })
  @ApiQuery({
    name: 'tail',
    description: 'Number of log entries to return',
    required: false,
    type: Number,
  })
  @ApiResponse({
    status: 200,
    description: 'Cluster error logs',
    type: ServerLogsResponseDto,
  })
  async getClusterErrorLogs(
    @Param('clusterId') clusterId: string,
    @Query('tail') tail: number = 100,
    @Query('serverId') serverId?: string,
  ): Promise<ServerLogsResponseDto> {
    const serverPart5 = serverId ? `, server: ${serverId}` : '';
    this.logger.debug(
      `Fetching error logs for cluster: ${clusterId}${serverPart5}`,
    );

    try {
      return await this.lokiQuery.getServerErrorLogs(clusterId, serverId, tail);
    } catch (error) {
      this.logger.error(
        `Failed to fetch error logs for cluster ${clusterId}: ${error.message}`,
      );
      throw error;
    }
  }
}
