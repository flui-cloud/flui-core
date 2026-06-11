import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import axios, { AxiosInstance } from 'axios';
import {
  ClusterEntity,
  ClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { LokiQueryResponse } from '../interfaces/loki-response.interface';
import { LogEntryDto, ServerLogsResponseDto } from '../dto';
import {
  AppLogEntryDto,
  AppLogsResponseDto,
  AppLogVolumeResponseDto,
  LogVolumeLevelSeriesDto,
} from '../dto/app-logs-response.dto';
import {
  AppLogsQueryDto,
  AppLogVolumeQueryDto,
} from '../dto/app-logs-query.dto';

/**
 * Loki Query Service
 *
 * Executes LogQL queries against Loki HTTP API
 * and provides helper methods for common log queries.
 *
 * Loki log labels (cluster_id, server_id) match database UUIDs directly
 * because the CLI passes its own UUIDs as primary keys during registration.
 */
@Injectable()
export class LokiQueryService {
  private readonly logger = new Logger(LokiQueryService.name);
  private readonly envLokiUrl?: string;
  private readonly httpClient: AxiosInstance;
  private cachedBaseUrl?: string;
  private cachedAt = 0;
  private static readonly CACHE_TTL_MS = 60_000;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
  ) {
    this.envLokiUrl = this.configService.get<string>('LOKI_ENDPOINT');

    this.httpClient = axios.create({ timeout: 30000 });

    this.logger.log(
      `Loki client initialized (env LOKI_ENDPOINT=${this.envLokiUrl ?? 'unset'}; endpoint resolved per query from observability cluster)`,
    );
  }

  private async resolveBaseUrl(): Promise<string> {
    const now = Date.now();
    if (
      this.cachedBaseUrl &&
      now - this.cachedAt < LokiQueryService.CACHE_TTL_MS
    ) {
      return this.cachedBaseUrl;
    }

    let source: 'env' | 'cluster' | undefined;
    let resolved = this.envLokiUrl;
    if (resolved) {
      source = 'env';
    } else {
      const obsCluster = await this.clusterRepository.findOne({
        where: { clusterType: ClusterType.OBSERVABILITY },
      });
      resolved = obsCluster?.metadata?.observabilityStack?.endpoints?.loki as
        | string
        | undefined;
      if (resolved) source = 'cluster';
    }

    if (!resolved) {
      throw new Error(
        'Loki endpoint not configured: LOKI_ENDPOINT is unset and no observability cluster has Loki endpoint metadata',
      );
    }

    if (resolved !== this.cachedBaseUrl) {
      this.logger.log(
        `Loki endpoint resolved to ${resolved} (source: ${source === 'env' ? 'LOKI_ENDPOINT env' : 'observability cluster metadata'})`,
      );
    }
    this.cachedBaseUrl = resolved;
    this.cachedAt = now;
    return resolved;
  }

  private async lokiGet<T = any>(
    path: string,
    params?: Record<string, string | number>,
  ) {
    const baseURL = await this.resolveBaseUrl();
    return this.httpClient.get<T>(path, { baseURL, params });
  }

  /**
   * Get all indexed stream label names from Loki.
   */
  async getLabels(): Promise<string[]> {
    try {
      const res = await this.lokiGet('/loki/api/v1/labels');
      return res.data?.data ?? [];
    } catch (error) {
      this.logger.error(`Failed to get Loki labels: ${error.message}`);
      throw new Error(`Loki labels query failed: ${error.message}`);
    }
  }

  /**
   * Get all values for a given Loki label (useful for diagnostics).
   */
  async getLabelValues(label: string): Promise<string[]> {
    try {
      const res = await this.lokiGet(`/loki/api/v1/label/${label}/values`);
      return res.data?.data ?? [];
    } catch (error) {
      this.logger.error(
        `Failed to get label values for "${label}": ${error.message}`,
      );
      throw new Error(`Loki label query failed: ${error.message}`);
    }
  }

  /**
   * Fetch one raw log stream to inspect the actual stream labels Vector sends.
   * Returns the stream label set of the first matching stream, plus a sample log line.
   */
  async getSampleStream(limit = 1): Promise<{
    streamLabels: Record<string, string>;
    sampleLine: string;
  } | null> {
    try {
      const res = await this.lokiGet('/loki/api/v1/query_range', {
        query: '{cluster_id=~".+"}',
        limit,
      });
      const result = res.data?.data?.result?.[0];
      if (!result) return null;
      return {
        streamLabels: result.stream,
        sampleLine: result.values?.[0]?.[1] ?? '',
      };
    } catch (error) {
      this.logger.error(`Sample stream query failed: ${error.message}`);
      throw new Error(`Sample stream query failed: ${error.message}`);
    }
  }

  /**
   * Execute LogQL query
   */
  async queryLogs(
    logQL: string,
    limit: number = 100,
    start?: string,
    end?: string,
  ): Promise<LokiQueryResponse> {
    try {
      const now = Date.now();
      const params: any = {
        query: logQL,
        limit,
        // Default to last 24h when no range is specified
        start: start
          ? new Date(start).getTime() * 1000000
          : (now - 24 * 60 * 60 * 1000) * 1000000,
        end: end ? new Date(end).getTime() * 1000000 : now * 1000000,
      };

      const response = await this.lokiGet('/loki/api/v1/query_range', params);

      return response.data as LokiQueryResponse;
    } catch (error) {
      const status = error.response?.status;
      const body = JSON.stringify(
        error.response?.data ?? error.code ?? error.message,
      );
      this.logger.error(
        `Loki query failed [${status ?? 'NETWORK'}]: ${body}, query: ${logQL}`,
      );
      throw new Error(`Loki query failed: ${body}`);
    }
  }

  /**
   * List the queryable log sources for a cluster: the distinct `app` and `namespace`
   * label values Loki has indexed. Lets a caller discover the exact (lowercase, indexed)
   * labels instead of guessing from a display name — the selector is exact-match, so a
   * near-miss silently returns nothing.
   */
  async getLogSources(
    clusterId: string,
  ): Promise<{ apps: string[]; namespaces: string[] }> {
    const now = Date.now();
    const params: Record<string, string | number> = {
      'match[]': `{cluster_id="${clusterId}"}`,
      start: (now - 24 * 60 * 60 * 1000) * 1000000,
      end: now * 1000000,
    };
    try {
      const res = await this.lokiGet<{ data?: Record<string, string>[] }>(
        '/loki/api/v1/series',
        params,
      );
      const streams = res.data?.data ?? [];
      const distinct = (key: string): string[] =>
        [
          ...new Set(
            streams
              .map((s) => s[key])
              .filter(
                (v): v is string => typeof v === 'string' && v.length > 0,
              ),
          ),
        ].sort((a, b) => a.localeCompare(b));
      return { apps: distinct('app'), namespaces: distinct('namespace') };
    } catch (error) {
      this.logger.error(`Loki series query failed: ${error.message}`);
      throw new Error(`Loki sources query failed: ${error.message}`);
    }
  }

  /**
   * Get logs for a specific server
   */
  async getServerLogs(
    clusterId: string,
    serverId?: string,
    limit: number = 200,
    component?: string,
    search?: string,
    start?: string,
    end?: string,
  ): Promise<ServerLogsResponseDto> {
    // Build LogQL query using cluster_id (matches DB UUID directly)
    let logQL = serverId
      ? `{cluster_id="${clusterId}",server_id="${serverId}"}`
      : `{cluster_id="${clusterId}"}`;

    // Add component filter
    if (component) {
      logQL += ` | json | component="${component}"`;
    }

    // Add search filter
    if (search) {
      logQL += ` |~ "(?i)${search}"`; // Case insensitive search
    }

    const response = await this.queryLogs(logQL, limit, start, end);

    const logs: LogEntryDto[] = [];

    if (response.status === 'success' && response.data?.result) {
      for (const stream of response.data.result) {
        for (const [timestamp, logLine] of stream.values) {
          try {
            // Try to parse JSON log
            const parsedLog = JSON.parse(logLine);

            logs.push({
              timestamp: new Date(
                Number.parseInt(timestamp) / 1000000,
              ).toISOString(),
              component: parsedLog.component || stream.stream.component,
              level: parsedLog.level || parsedLog.severity,
              message: parsedLog.message || logLine,
              metadata: parsedLog,
            });
          } catch {
            // If not JSON, treat as plain text
            logs.push({
              timestamp: new Date(
                Number.parseInt(timestamp) / 1000000,
              ).toISOString(),
              message: logLine,
            });
          }
        }
      }
    }

    // Sort logs by timestamp descending (newest first)
    logs.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    return {
      cluster_id: clusterId,
      server_id: serverId,
      count: logs.length,
      logs,
      queried_at: new Date().toISOString(),
    };
  }

  /**
   * Get error logs for a server
   */
  async getServerErrorLogs(
    clusterId: string,
    serverId?: string,
    limit: number = 100,
  ): Promise<ServerLogsResponseDto> {
    return this.getServerLogs(clusterId, serverId, limit, undefined, 'error');
  }

  /**
   * Get logs by component
   */
  async getServerComponentLogs(
    clusterId: string,
    serverId: string,
    component: string,
    limit: number = 200,
  ): Promise<ServerLogsResponseDto> {
    return this.getServerLogs(clusterId, serverId, limit, component);
  }

  /**
   * Get application logs filtered by Kubernetes labels (namespace, app, etc.)
   *
   * Builds a LogQL selector from the indexed labels present in the query.
   * All label filters use exact-match stream selectors for best performance.
   */
  async getAppLogs(
    clusterId: string,
    query: AppLogsQueryDto,
  ): Promise<AppLogsResponseDto> {
    const labelFilters: string[] = [`cluster_id="${clusterId}"`];

    if (query.namespace) labelFilters.push(`namespace="${query.namespace}"`);
    if (query.app) labelFilters.push(`app="${query.app}"`);
    if (query.container) labelFilters.push(`container="${query.container}"`);
    if (query.pod) labelFilters.push(`pod="${query.pod}"`);
    if (query.stream) labelFilters.push(`stream="${query.stream}"`);

    // level is an indexed label (Vector sets it), add it directly to the stream selector
    if (query.level) labelFilters.push(`level="${query.level}"`);

    const logQL_base = `{${labelFilters.join(',')}}`;

    // Full-text search is a line filter, applied after the selector
    const logQL = query.search
      ? `${logQL_base} |~ "(?i)${query.search}"`
      : logQL_base;

    const response = await this.queryLogs(
      logQL,
      query.tail ?? 200,
      query.start,
      query.end,
    );

    const logs: AppLogEntryDto[] = [];

    if (response.status === 'success' && response.data?.result) {
      for (const lokiStream of response.data.result) {
        const streamLabels = lokiStream.stream;

        for (const [tsNs, logLine] of lokiStream.values) {
          const entry: AppLogEntryDto = {
            timestamp: new Date(Number.parseInt(tsNs) / 1000000).toISOString(),
            namespace: streamLabels.namespace,
            app: streamLabels.app,
            pod: streamLabels.pod,
            container: streamLabels.container,
            stream: streamLabels.stream,
            server_id: streamLabels.server_id,
            hostname: streamLabels.hostname,
            server_type: streamLabels.server_type,
            message: logLine,
          };

          try {
            const parsed = JSON.parse(logLine);
            // Vector enriches the body with the same fields as stream labels.
            // message > log_message > msg, all present in the Vector schema.
            // Do NOT fall back to logLine here — it would expose the raw JSON blob.
            entry.level = streamLabels.level; // already indexed, prefer stream label
            entry.message =
              parsed.message || parsed.log_message || parsed.msg || '';
            // Omit redundant text/level fields from metadata — already surfaced top-level
            const redundant = new Set([
              'message',
              'log_message',
              'msg',
              'level',
              'severity',
            ]);
            entry.metadata = Object.fromEntries(
              Object.entries(parsed)
                .filter(([k]) => !redundant.has(k))
                .map(([k, v]) => [k, v as string | number | boolean]),
            );
          } catch {
            entry.level = streamLabels.level;
          }

          logs.push(entry);
        }
      }
    }

    logs.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    return {
      cluster_id: clusterId,
      namespace: query.namespace,
      app: query.app,
      count: logs.length,
      logs,
      queried_at: new Date().toISOString(),
    };
  }

  /**
   * Get log volume aggregated by level over a time range.
   *
   * Uses a Loki metric query (count_over_time … [step]) grouped by level.
   * This returns a Prometheus-style matrix — NO raw log lines are fetched,
   * making it efficient even for large time windows (like Grafana's log volume panel).
   */
  async getAppLogVolume(
    clusterId: string,
    query: AppLogVolumeQueryDto,
  ): Promise<AppLogVolumeResponseDto> {
    const step = query.step ?? '5m';

    const labelFilters: string[] = [`cluster_id="${clusterId}"`];
    if (query.namespace) labelFilters.push(`namespace="${query.namespace}"`);
    if (query.app) labelFilters.push(`app="${query.app}"`);
    if (query.container) labelFilters.push(`container="${query.container}"`);
    if (query.stream) labelFilters.push(`stream="${query.stream}"`);

    const selector = `{${labelFilters.join(',')}}`;

    const logQL = `sum by (level) (count_over_time(${selector} [${step}]))`;

    const startNs = new Date(query.start).getTime() * 1000000;
    const endNs = new Date(query.end).getTime() * 1000000;

    let response: LokiQueryResponse;
    try {
      const params: Record<string, string | number> = {
        query: logQL,
        start: startNs,
        end: endNs,
        step,
      };

      const res = await this.lokiGet('/loki/api/v1/query_range', params);
      response = res.data as LokiQueryResponse;
    } catch (error) {
      const status = error.response?.status;
      const body = JSON.stringify(
        error.response?.data ?? error.code ?? error.message,
      );
      this.logger.error(
        `Loki volume query failed [${status ?? 'NETWORK'}]: ${body}, query: ${logQL}`,
      );
      throw new Error(`Loki volume query failed: ${body}`);
    }

    const seriesMap = new Map<string, LogVolumeLevelSeriesDto>();

    if (response.status === 'success' && response.data?.result) {
      for (const result of response.data.result) {
        // Loki metric queries return `metric` (not `stream`) as the label map
        const labels: Record<string, string> =
          (result as unknown as { metric: Record<string, string> }).metric ??
          result.stream ??
          {};
        const level: string =
          labels.level && labels.level !== '' ? labels.level : 'unknown';

        if (!seriesMap.has(level)) {
          seriesMap.set(level, { level, series: [] });
        }

        const entry = seriesMap.get(level);

        for (const [tsStr, valueStr] of result.values) {
          const tsSeconds = Number.parseFloat(tsStr);
          entry.series.push({
            timestamp: tsSeconds,
            datetime: new Date(tsSeconds * 1000).toISOString(),
            count: Number.parseFloat(valueStr),
          });
        }
      }
    }

    // Sort each series by timestamp ascending (chart order)
    for (const s of seriesMap.values()) {
      s.series.sort((a, b) => a.timestamp - b.timestamp);
    }

    return {
      cluster_id: clusterId,
      namespace: query.namespace,
      app: query.app,
      range_start: query.start,
      range_end: query.end,
      step,
      series: Array.from(seriesMap.values()),
      queried_at: new Date().toISOString(),
    };
  }

  /**
   * Search logs across all servers
   */
  async searchAllServerLogs(
    search: string,
    limit: number = 100,
  ): Promise<LogEntryDto[]> {
    const logQL = `{job=~"flui-.*"} |~ "(?i)${search}"`;

    const response = await this.queryLogs(logQL, limit);

    const logs: LogEntryDto[] = [];

    if (response.status === 'success' && response.data?.result) {
      for (const stream of response.data.result) {
        for (const [timestamp, logLine] of stream.values) {
          try {
            const parsedLog = JSON.parse(logLine);
            logs.push({
              timestamp: new Date(
                Number.parseInt(timestamp) / 1000000,
              ).toISOString(),
              component: parsedLog.component,
              level: parsedLog.level,
              message: parsedLog.message || logLine,
              metadata: {
                ...parsedLog,
                server_id: stream.stream.server_id,
                server_type: stream.stream.server_type,
              },
            });
          } catch {
            logs.push({
              timestamp: new Date(
                Number.parseInt(timestamp) / 1000000,
              ).toISOString(),
              message: logLine,
              metadata: {
                server_id: stream.stream.server_id,
                server_type: stream.stream.server_type,
              },
            });
          }
        }
      }
    }

    logs.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );

    return logs;
  }
}
