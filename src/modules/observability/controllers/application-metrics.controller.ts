import {
  Controller,
  Get,
  Param,
  Query,
  Logger,
  UseGuards,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { AppAccessGuard } from '../../applications/guards/app-access.guard';
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { ApplicationMetricsService } from '../services/application-metrics.service';
import { ApplicationService } from '../../applications/services/application.service';
import {
  SingleAppMetricsResponseDto,
  ClusterAppsMetricsResponseDto,
  SingleAppMetricsHistoryResponseDto,
  ClusterAppsMetricsHistoryResponseDto,
} from '../dto/application-metrics.dto';
import { MetricsHistoryQueryDto } from '../dto/server-metrics-response.dto';

/**
 * Application Metrics Controller
 *
 * Provides metrics endpoints for Flui-managed applications.
 * Queries pre-computed flui:* recording rules from Prometheus.
 */
@ApiTags('Application Metrics')
@ApiBearerAuth()
@Controller('observability')
export class ApplicationMetricsController {
  private readonly logger = new Logger(ApplicationMetricsController.name);

  constructor(
    private readonly appMetricsService: ApplicationMetricsService,
    private readonly applicationService: ApplicationService,
    private readonly applicationAccess: ApplicationAccessService,
  ) {}

  /**
   * Get instant metrics for a single application
   */
  @Get('applications/:appId/metrics')
  // How much CPU and memory an application is using, and how many replicas it
  // is running, is not public within an instance: the traffic and alert routes
  // next door have always gated the same shape of question.
  @UseGuards(AppAccessGuard)
  @ApiOperation({
    summary: 'Get application metrics',
    description:
      'Returns instant CPU, memory, network, replica, and pod metrics ' +
      'for a single application. Queries pre-computed flui:* recording rules from Prometheus.',
  })
  @ApiParam({ name: 'appId', description: 'Application ID (UUID)' })
  @ApiResponse({
    status: 200,
    description: 'Application metrics retrieved successfully',
    type: SingleAppMetricsResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Application not found' })
  async getAppMetrics(
    @Param('appId') appId: string,
  ): Promise<SingleAppMetricsResponseDto> {
    const app = await this.applicationService.findById(appId);

    this.logger.debug(
      `Fetching instant metrics for app "${app.slug}" in namespace "${app.k8sNamespace}"`,
    );

    const metrics = await this.appMetricsService.getAppMetricsInstant(
      app.id,
      app.slug,
      app.k8sNamespace,
    );

    return {
      app_id: app.id,
      app_name: app.slug,
      namespace: app.k8sNamespace,
      cluster_id: app.clusterId,
      metrics,
      queried_at: new Date().toISOString(),
    };
  }

  /**
   * Get metrics history for a single application
   */
  @Get('applications/:appId/metrics/history')
  @UseGuards(AppAccessGuard)
  @ApiOperation({
    summary: 'Get application metrics history',
    description:
      'Returns historical CPU, memory, network, and replica metrics ' +
      'for a single application over a time range.',
  })
  @ApiParam({ name: 'appId', description: 'Application ID (UUID)' })
  @ApiResponse({
    status: 200,
    description: 'Application metrics history retrieved successfully',
    type: SingleAppMetricsHistoryResponseDto,
  })
  @ApiResponse({ status: 404, description: 'Application not found' })
  async getAppMetricsHistory(
    @Param('appId') appId: string,
    @Query() query: MetricsHistoryQueryDto,
  ): Promise<SingleAppMetricsHistoryResponseDto> {
    const app = await this.applicationService.findById(appId);
    const startUnix = Math.floor(new Date(query.start).getTime() / 1000);
    const endUnix = Math.floor(new Date(query.end).getTime() / 1000);
    const step = query.step || '60s';

    this.logger.debug(
      `Fetching metrics history for app "${app.slug}": ${query.start} -> ${query.end} (step: ${step})`,
    );

    const dataPoints = await this.appMetricsService.getAppMetricsHistory(
      app.id,
      app.slug,
      app.k8sNamespace,
      startUnix,
      endUnix,
      step,
    );

    return {
      app_id: app.id,
      app_name: app.slug,
      namespace: app.k8sNamespace,
      cluster_id: app.clusterId,
      range_start: query.start,
      range_end: query.end,
      step,
      data_points: dataPoints,
      queried_at: new Date().toISOString(),
    };
  }

  /**
   * Get instant metrics for readable applications in a cluster
   */
  @Get('clusters/:clusterId/applications/metrics')
  @ApiOperation({
    summary: 'Get metrics for readable applications in a cluster',
    description:
      'Returns instant metrics for applications in the cluster that the caller may read. ' +
      'Fetches the app list from the database, then queries Prometheus for each app in parallel.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID (UUID)' })
  @ApiResponse({
    status: 200,
    description: 'Cluster application metrics retrieved successfully',
    type: ClusterAppsMetricsResponseDto,
  })
  async getClusterAppsMetrics(
    @Param('clusterId') clusterId: string,
    @Req() req: Request,
  ): Promise<ClusterAppsMetricsResponseDto> {
    this.logger.debug(
      `Fetching instant metrics for all apps in cluster ${clusterId}`,
    );

    const user = req.user as AuthenticatedUser | undefined;
    const apps = await this.applicationService.findByClusterId(clusterId);
    const readable = user
      ? await this.applicationAccess.filterReadable(user, apps)
      : [];
    const applications =
      await this.appMetricsService.getAppsMetricsInstant(readable);

    return {
      cluster_id: clusterId,
      applications,
      queried_at: new Date().toISOString(),
    };
  }

  /**
   * Get metrics history for readable applications in a cluster
   */
  @Get('clusters/:clusterId/applications/metrics/history')
  @ApiOperation({
    summary: 'Get metrics history for readable applications in a cluster',
    description:
      'Returns historical metrics for applications in the cluster that the caller may read.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID (UUID)' })
  @ApiResponse({
    status: 200,
    description: 'Cluster application metrics history retrieved successfully',
    type: ClusterAppsMetricsHistoryResponseDto,
  })
  async getClusterAppsMetricsHistory(
    @Param('clusterId') clusterId: string,
    @Query() query: MetricsHistoryQueryDto,
    @Req() req: Request,
  ): Promise<ClusterAppsMetricsHistoryResponseDto> {
    const startUnix = Math.floor(new Date(query.start).getTime() / 1000);
    const endUnix = Math.floor(new Date(query.end).getTime() / 1000);
    const step = query.step || '60s';

    this.logger.debug(
      `Fetching metrics history for all apps in cluster ${clusterId}: ${query.start} -> ${query.end} (step: ${step})`,
    );

    const user = req.user as AuthenticatedUser | undefined;
    const apps = await this.applicationService.findByClusterId(clusterId);
    const readable = user
      ? await this.applicationAccess.filterReadable(user, apps)
      : [];
    const applications = await this.appMetricsService.getAppsMetricsHistory(
      readable,
      startUnix,
      endUnix,
      step,
    );

    return {
      cluster_id: clusterId,
      range_start: query.start,
      range_end: query.end,
      step,
      applications,
      queried_at: new Date().toISOString(),
    };
  }
}
