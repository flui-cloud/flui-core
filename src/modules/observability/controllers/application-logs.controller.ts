import {
  Controller,
  Get,
  Param,
  Query,
  Logger,
  UseGuards,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiQuery,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { LokiQueryService } from '../services';
import {
  AppLogsQueryDto,
  AppLogVolumeQueryDto,
  ApplicationLogsQueryDto,
  ApplicationLogVolumeQueryDto,
} from '../dto/app-logs-query.dto';
import {
  AppLogsResponseDto,
  AppLogVolumeResponseDto,
} from '../dto/app-logs-response.dto';
import { ApplicationService } from '../../applications/services/application.service';
import { AppAccessGuard } from '../../applications/guards/app-access.guard';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { SECTION } from '../../iam/constants/iam-sections';

/**
 * Application Logs Controller
 *
 * Provides log retrieval and log-volume (chart) endpoints for Kubernetes
 * application logs, filtered by namespace, app name and other indexed labels.
 *
 * Endpoints:
 *   GET /observability/clusters/:clusterId/apps/logs         - raw logs with filters
 *   GET /observability/clusters/:clusterId/apps/logs/volume  - level-over-time chart data
 */
@ApiTags('Application Logs')
@ApiBearerAuth()
@Controller('observability')
export class ApplicationLogsController {
  private readonly logger = new Logger(ApplicationLogsController.name);

  constructor(
    private readonly lokiQuery: LokiQueryService,
    private readonly applicationService: ApplicationService,
  ) {}

  /**
   * Diagnostic endpoint — shows all stream label names Loki has indexed,
   * the known values of cluster_id, and a sample raw stream from Vector.
   * Use this to verify label names before querying.
   */
  @Get('loki/debug')
  // Returns a real log line drawn from `{cluster_id=~".+"}` — any stream in the
  // cluster, whoever it belongs to — plus the whole label inventory. It is a
  // diagnostic for whoever runs the instance, not a route a tenant may call.
  @RequireSection(SECTION.INFRASTRUCTURE)
  @ApiOperation({
    summary: 'Loki diagnostics',
    description:
      'Returns all indexed stream label names, cluster_id values present in Loki, ' +
      'and a sample raw stream to verify what Vector is actually sending.',
  })
  @ApiResponse({ status: 200 })
  async lokiDebug(): Promise<{
    labels: string[];
    cluster_id_values: string[];
    sample_stream: {
      streamLabels: Record<string, string>;
      sampleLine: string;
    } | null;
  }> {
    const [labels, cluster_id_values, sample_stream] = await Promise.all([
      this.lokiQuery.getLabels(),
      this.lokiQuery.getLabelValues('cluster_id'),
      this.lokiQuery.getSampleStream(),
    ]);
    return { labels, cluster_id_values, sample_stream };
  }

  /**
   * The exact label values a caller must use to query logs, discoverable rather
   * than guessed: the selector is exact-match, so a display name silently
   * returns nothing.
   *
   * Same gate as `loki/debug` two methods up, and for the same reason: this is
   * the label inventory of a whole cluster — every tenant's application and
   * namespace names — so it belongs to whoever runs the instance. A tenant
   * reads its own application's logs through
   * `GET /observability/applications/:id/logs`, which carries AppAccessGuard
   * and needs no discovery step at all.
   *
   * It exists because the MCP tool `log_sources` had no route to call and was
   * reaching the service in process, which is exactly the bypass strada B
   * removes. Its gate is the one decision 6 will give the rest of this family.
   */
  @Get('clusters/:clusterId/apps/log-sources')
  @RequireSection(SECTION.INFRASTRUCTURE)
  // `app:read` on top of the section: the `infrastructure` section admits only
  // `full`, which is `cluster:manage` at global scope, and every role holding
  // that holds `app:read` too, so this takes nothing from anybody. It is what
  // brings the cluster-wide log search inside the credential ceiling, which
  // reads `@RequirePermission` and `@AppAction` and nothing else.
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'List the queryable log sources of a cluster',
    description:
      'The distinct `app` and `namespace` label values Loki has indexed for ' +
      'this cluster over the last 24h. They are lowercase indexed labels, not ' +
      'display names.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  @ApiResponse({ status: 200 })
  async logSources(
    @Param('clusterId') clusterId: string,
  ): Promise<{ apps: string[]; namespaces: string[] }> {
    return this.lokiQuery.getLogSources(clusterId);
  }

  /**
   * Get application logs filtered by namespace, app, container, pod, level, etc.
   */
  // Still the boolean, deliberately: this is the route `flui app logs` calls,
  // and giving it the infrastructure section would leave the CLI broken for an
  // operator while looking like the gate had been fixed. The pair — section here
  // and the CLI moved to the per-application route, which already has
  // AppAccessGuard — is decision 6, still open.
  // Cluster-wide: reads the logs of *everything* running on the cluster, so it
  // belongs to whoever runs the instance — the same gate `loki/debug` and
  // `log-sources` already carry. This widens rather than narrows: before, only
  // the boolean got through; now `cluster:manage` at global scope does too, and
  // that is intended. A tenant reads its own application through
  // `GET /observability/applications/:id/logs`, which the CLI now uses.
  @Get('clusters/:clusterId/apps/logs')
  @RequireSection(SECTION.INFRASTRUCTURE)
  // Same pair, same reason as `log-sources` above.
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'Get application logs',
    description:
      'Returns log lines for Kubernetes workloads in a cluster. ' +
      'Filter by namespace, app, container, pod, stream or level. ' +
      'All label filters are pushed down to Loki stream selectors for efficiency.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID (GUID)' })
  @ApiQuery({
    name: 'namespace',
    required: false,
    description: 'Kubernetes namespace',
  })
  @ApiQuery({
    name: 'app',
    required: false,
    description: 'App label (e.g. my-api)',
  })
  @ApiQuery({
    name: 'container',
    required: false,
    description: 'Container name',
  })
  @ApiQuery({ name: 'pod', required: false, description: 'Pod name' })
  @ApiQuery({
    name: 'stream',
    required: false,
    enum: ['stdout', 'stderr'],
    description: 'Log stream',
  })
  @ApiQuery({
    name: 'level',
    required: false,
    description: 'Log level (info, warn, error, …)',
  })
  @ApiQuery({
    name: 'search',
    required: false,
    description: 'Full-text search (case insensitive)',
  })
  @ApiQuery({
    name: 'tail',
    required: false,
    type: Number,
    description: 'Max lines to return (1–10000, default 200)',
  })
  @ApiQuery({
    name: 'start',
    required: false,
    description: 'Start time (ISO 8601)',
  })
  @ApiQuery({
    name: 'end',
    required: false,
    description: 'End time (ISO 8601)',
  })
  @ApiResponse({
    status: 200,
    description: 'Application log entries',
    type: AppLogsResponseDto,
  })
  async getAppLogs(
    @Param('clusterId') clusterId: string,
    @Query() query: AppLogsQueryDto,
  ): Promise<AppLogsResponseDto> {
    this.logger.debug(
      `App logs — cluster: ${clusterId}, ns: ${query.namespace}, app: ${query.app}`,
    );

    try {
      return await this.lokiQuery.getAppLogs(clusterId, query);
    } catch (error) {
      this.logger.error(
        `Failed to fetch app logs for cluster ${clusterId}: ${error.message}`,
      );
      throw error;
    }
  }

  @Get('applications/:id/logs')
  @UseGuards(AppAccessGuard)
  @ApiOperation({
    summary: 'Get logs for an application',
    description:
      'Returns log lines for one application. The namespace and workload identity are derived from the application record.',
  })
  @ApiParam({ name: 'id', description: 'Application ID (UUID)' })
  @ApiResponse({
    status: 200,
    description: 'Application log entries',
    type: AppLogsResponseDto,
  })
  async getApplicationLogs(
    @Param('id') appId: string,
    @Query() query: ApplicationLogsQueryDto,
  ): Promise<AppLogsResponseDto> {
    const app = await this.applicationService.findById(appId);
    return this.lokiQuery.getAppLogs(app.clusterId, {
      namespace: app.k8sNamespace,
      container: app.slug,
      pod: query.pod,
      stream: query.stream,
      level: query.level,
      search: query.search,
      tail: query.tail,
      start: query.start,
      end: query.end,
    });
  }

  /**
   * Get log volume aggregated by level over a time range (chart data).
   *
   * Uses a Loki metric query (count_over_time grouped by level) — no raw logs
   * are fetched. This is the same technique Grafana uses for its log volume panel.
   */
  @Get('clusters/:clusterId/apps/logs/volume')
  @RequireSection(SECTION.INFRASTRUCTURE)
  @ApiOperation({
    summary: 'Get log volume over time (chart data)',
    description:
      'Returns the count of log lines per level in each time bucket over the given range. ' +
      'Uses a Loki metric query (count_over_time … grouped by level) so no raw log lines ' +
      'are transferred — suitable for large time windows and high-cardinality workloads.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID (GUID)' })
  @ApiQuery({
    name: 'namespace',
    required: false,
    description: 'Kubernetes namespace',
  })
  @ApiQuery({
    name: 'app',
    required: false,
    description: 'App label (e.g. my-api)',
  })
  @ApiQuery({
    name: 'container',
    required: false,
    description: 'Container name',
  })
  @ApiQuery({
    name: 'stream',
    required: false,
    enum: ['stdout', 'stderr'],
    description: 'Log stream',
  })
  @ApiQuery({
    name: 'start',
    required: true,
    description: 'Range start (ISO 8601)',
    example: '2025-01-18T00:00:00Z',
  })
  @ApiQuery({
    name: 'end',
    required: true,
    description: 'Range end (ISO 8601)',
    example: '2025-01-18T23:59:59Z',
  })
  @ApiQuery({
    name: 'step',
    required: false,
    description: 'Bucket size (e.g. 1m, 5m, 1h — default 5m)',
    example: '5m',
  })
  @ApiResponse({
    status: 200,
    description: 'Log volume time series per level',
    type: AppLogVolumeResponseDto,
  })
  async getAppLogVolume(
    @Param('clusterId') clusterId: string,
    @Query() query: AppLogVolumeQueryDto,
  ): Promise<AppLogVolumeResponseDto> {
    this.logger.debug(
      `App log volume — cluster: ${clusterId}, ns: ${query.namespace}, app: ${query.app}, ` +
        `range: ${query.start} → ${query.end}, step: ${query.step}`,
    );

    try {
      return await this.lokiQuery.getAppLogVolume(clusterId, query);
    } catch (error) {
      this.logger.error(
        `Failed to fetch log volume for cluster ${clusterId}: ${error.message}`,
      );
      throw error;
    }
  }

  @Get('applications/:id/logs/volume')
  @UseGuards(AppAccessGuard)
  @ApiOperation({
    summary: 'Get log volume for an application',
    description:
      'Returns log volume for one application. The namespace and workload identity are derived from the application record.',
  })
  @ApiParam({ name: 'id', description: 'Application ID (UUID)' })
  @ApiResponse({
    status: 200,
    description: 'Log volume time series per level',
    type: AppLogVolumeResponseDto,
  })
  async getApplicationLogVolume(
    @Param('id') appId: string,
    @Query() query: ApplicationLogVolumeQueryDto,
  ): Promise<AppLogVolumeResponseDto> {
    const app = await this.applicationService.findById(appId);
    return this.lokiQuery.getAppLogVolume(app.clusterId, {
      namespace: app.k8sNamespace,
      container: app.slug,
      stream: query.stream,
      start: query.start,
      end: query.end,
      step: query.step,
    });
  }
}
