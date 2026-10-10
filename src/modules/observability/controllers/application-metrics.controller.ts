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
import { AppHealthChecksService } from '../services/app-health-checks.service';
import { CapacityAdviceService } from '../services/capacity-advice.service';
import { ApplicationService } from '../../applications/services/application.service';
import {
  SingleAppMetricsResponseDto,
  AppHealthChecksResponseDto,
  AppCapacityAdviceResponseDto,
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
    private readonly healthChecks: AppHealthChecksService,
    private readonly capacityAdvice: CapacityAdviceService,
  ) {}

  @Get('applications/:appId/capacity-advice')
  @UseGuards(AppAccessGuard)
  @ApiOperation({
    summary:
      'Whether the application needs more copies, a node to put them on, or neither',
    description:
      'Judged on the last minutes of CPU throttling, CPU and memory against their limits, failed health checks, copies waiting for a node and the autoscaler. When copies are saturated, the answer says whether another one has room, makes the scaling group buy a node, or has nowhere to run. Thresholds come from FLUI_ADVICE_* variables.',
  })
  @ApiParam({ name: 'appId', description: 'Application ID (UUID)' })
  @ApiResponse({ status: 200, type: AppCapacityAdviceResponseDto })
  async getCapacityAdvice(
    @Param('appId') appId: string,
  ): Promise<AppCapacityAdviceResponseDto> {
    const a = await this.capacityAdvice.advise(appId);
    return {
      app_id: a.appId,
      advice: a.advice,
      sentence: a.sentence,
      reasons: a.reasons,
      desired: a.desired,
      ready: a.ready,
      measures: {
        throttled_percent: a.measures.throttledPercent,
        cpu_percent: a.measures.cpuPercent,
        memory_percent: a.measures.memoryPercent,
        readiness_failures: a.measures.readinessFailures,
        restarts_by_liveness: a.measures.restartsByLiveness,
      },
      next_copy: a.nextCopy,
      thresholds: {
        window_minutes: a.thresholds.windowMinutes,
        throttled_percent: a.thresholds.throttledPercent,
        cpu_percent: a.thresholds.cpuPercent,
        memory_percent: a.thresholds.memoryPercent,
        readiness_failures: a.thresholds.readinessFailures,
      },
    };
  }

  @Get('applications/:appId/health-checks')
  @UseGuards(AppAccessGuard)
  @ApiOperation({
    summary:
      "The application's failed health checks in the last hour, as the cluster recorded them",
    description:
      'A copy that stops answering its readiness check is taken out of the route; with no other copy ready, visitors get errors. Such a gap can be shorter than the interval metrics are sampled at, so it is read from the events, which keep it.',
  })
  @ApiParam({ name: 'appId', description: 'Application ID (UUID)' })
  @ApiResponse({ status: 200, type: AppHealthChecksResponseDto })
  async getHealthChecks(
    @Param('appId') appId: string,
  ): Promise<AppHealthChecksResponseDto> {
    const app = await this.applicationService.findById(appId);
    const f = await this.healthChecks.failures(app);
    return {
      app_id: app.id,
      readiness: f.readiness,
      readiness_busy: f.readinessBusy,
      liveness: f.liveness,
      startup: f.startup,
      restarts_by_liveness: f.restartsByLiveness,
      last_failure_at: f.lastFailureAt,
      read: f.read,
    };
  }

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
