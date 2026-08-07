import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ApplicationTrafficService } from '../services/application-traffic.service';
import { ApplicationService } from '../../applications/services/application.service';
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import { AppAccessGuard } from '../../applications/guards/app-access.guard';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import {
  ClusterAppTrafficSummaryDto,
  ClusterTrafficResponseDto,
  SingleAppTrafficHistoryResponseDto,
  SingleAppTrafficResponseDto,
  TrafficHistoryQueryDto,
  TrafficQueryDto,
} from '../dto/application-traffic.dto';

const DEFAULT_WINDOW = '5m';
const DEFAULT_STEP = '60s';

/**
 * Application Traffic Controller
 *
 * Edge HTTP signals (rate, errors, latency) for Flui-managed applications, read from
 * Traefik metrics. Available for every routable application without instrumenting it.
 */
@ApiTags('Application Traffic')
@ApiBearerAuth()
@Controller('observability')
export class ApplicationTrafficController {
  constructor(
    private readonly traffic: ApplicationTrafficService,
    private readonly applicationService: ApplicationService,
    private readonly applicationAccess: ApplicationAccessService,
  ) {}

  @Get('applications/:id/traffic')
  @UseGuards(AppAccessGuard)
  @ApiOperation({
    summary: 'Get application traffic',
    description:
      'Returns request rate, status-code breakdown and latency percentiles for a single ' +
      'application, measured at the ingress. Requires no instrumentation in the application. ' +
      'An application not exposed through the ingress returns is_routable=false with null metrics.',
  })
  @ApiParam({ name: 'id', description: 'Application ID (UUID)' })
  @ApiResponse({ status: 200, type: SingleAppTrafficResponseDto })
  @ApiResponse({ status: 404, description: 'Application not found' })
  async getAppTraffic(
    @Param('id') appId: string,
    @Query() query: TrafficQueryDto,
  ): Promise<SingleAppTrafficResponseDto> {
    const app = await this.applicationService.findById(appId);
    const window = query.window || DEFAULT_WINDOW;
    const target = {
      slug: app.slug,
      namespace: app.k8sNamespace,
      port: app.port,
      portProtocol: app.portProtocol,
    };

    const traffic = await this.traffic.getTrafficInstant(target, window);

    return {
      app_id: app.id,
      app_name: app.slug,
      namespace: app.k8sNamespace,
      cluster_id: app.clusterId,
      traefik_service: this.traffic.buildTraefikServiceId(target),
      is_routable: this.traffic.isRoutable(target),
      window,
      traffic,
      queried_at: new Date().toISOString(),
    };
  }

  @Get('applications/:id/traffic/history')
  @UseGuards(AppAccessGuard)
  @ApiOperation({
    summary: 'Get application traffic history',
    description:
      'Returns request rate, 4xx/5xx rates and p95 latency over a time range, ' +
      'for charting alongside the resource metrics on the same time axis.',
  })
  @ApiParam({ name: 'id', description: 'Application ID (UUID)' })
  @ApiResponse({ status: 200, type: SingleAppTrafficHistoryResponseDto })
  @ApiResponse({ status: 404, description: 'Application not found' })
  async getAppTrafficHistory(
    @Param('id') appId: string,
    @Query() query: TrafficHistoryQueryDto,
  ): Promise<SingleAppTrafficHistoryResponseDto> {
    const app = await this.applicationService.findById(appId);
    const window = query.window || DEFAULT_WINDOW;
    const step = query.step || DEFAULT_STEP;
    const startUnix = Math.floor(new Date(query.start).getTime() / 1000);
    const endUnix = Math.floor(new Date(query.end).getTime() / 1000);
    const target = {
      slug: app.slug,
      namespace: app.k8sNamespace,
      port: app.port,
      portProtocol: app.portProtocol,
    };

    const dataPoints = await this.traffic.getTrafficHistory(
      target,
      startUnix,
      endUnix,
      step,
      window,
    );

    return {
      app_id: app.id,
      app_name: app.slug,
      namespace: app.k8sNamespace,
      cluster_id: app.clusterId,
      traefik_service: this.traffic.buildTraefikServiceId(target),
      is_routable: this.traffic.isRoutable(target),
      range_start: query.start,
      range_end: query.end,
      step,
      window,
      data_points: dataPoints,
      queried_at: new Date().toISOString(),
    };
  }

  @Get('clusters/:clusterId/traffic')
  @ApiOperation({
    summary: 'Get traffic for all applications in a cluster',
    description:
      'Returns a per-application traffic summary for the cluster, restricted to the ' +
      'applications the caller may read. Uses aggregate queries rather than one per application.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID (UUID)' })
  @ApiResponse({ status: 200, type: ClusterTrafficResponseDto })
  async getClusterTraffic(
    @Param('clusterId') clusterId: string,
    @Query() query: TrafficQueryDto,
    @Req() req: Request,
  ): Promise<ClusterTrafficResponseDto> {
    const user = req.user as AuthenticatedUser | undefined;
    const window = query.window || DEFAULT_WINDOW;

    const apps = await this.applicationService.findByClusterId(clusterId);
    const readable = user
      ? await this.applicationAccess.filterReadable(user, apps)
      : [];

    const byService = await this.traffic.getClusterTrafficByService(window);

    const applications = readable.map<ClusterAppTrafficSummaryDto>((app) => {
      const target = {
        slug: app.slug,
        namespace: app.k8sNamespace,
        port: app.port,
        portProtocol: app.portProtocol,
      };
      const serviceId = this.traffic.buildTraefikServiceId(target);
      const summary = serviceId ? byService.get(serviceId) : undefined;

      return {
        app_id: app.id,
        app_name: app.slug,
        namespace: app.k8sNamespace,
        traefik_service: serviceId,
        is_routable: this.traffic.isRoutable(target),
        requests_per_second: summary ? summary.rps : null,
        server_error_percent: summary ? summary.serverErrorPercent : null,
        p95_seconds: summary ? summary.p95 : null,
      };
    });

    return {
      cluster_id: clusterId,
      window,
      applications,
      queried_at: new Date().toISOString(),
    };
  }
}
