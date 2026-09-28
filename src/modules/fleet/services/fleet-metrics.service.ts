import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { PrometheusQueryService } from '../../observability/services/prometheus-query.service';
import {
  ClusterMetricsState,
  FLEET_WINDOWS,
  FleetPoint,
  FleetWindow,
  NodeHistory,
  aggregateNodes,
  stateOf,
} from '../utils/fleet-metrics.aggregate';

export interface ClusterMetricsRow {
  clusterId: string;
  name: string;
  provider: string;
  clusterType: string;
  status: string;
  metrics: ClusterMetricsState;
  nodesReporting: number;
  lastSampleAt: string | null;
  current: FleetPoint | null;
  series: FleetPoint[];
}

export interface FleetMetrics {
  window: FleetWindow;
  step: string;
  rangeStart: string;
  rangeEnd: string;
  queriedAt: string;
  fleet: {
    clustersTotal: number;
    clustersReporting: number;
    nodesReporting: number;
    /** Null when no cluster is reporting now: an empty fleet has no reading, not a zero one. */
    current: FleetPoint | null;
    series: FleetPoint[];
  };
  clusters: ClusterMetricsRow[];
}

/**
 * Node metrics for every cluster at once, read through the same query the
 * cluster Monitoring page uses, so a tile on the home and the chart on the
 * cluster can never disagree about what "CPU" means.
 */
@Injectable()
export class FleetMetricsService {
  private readonly logger = new Logger(FleetMetricsService.name);

  constructor(
    private readonly prometheus: PrometheusQueryService,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
  ) {}

  async getMetrics(
    window: FleetWindow,
    now = new Date(),
  ): Promise<FleetMetrics> {
    const { seconds, step, stepSeconds } = FLEET_WINDOWS[window];
    const endUnix =
      Math.floor(now.getTime() / 1000 / stepSeconds) * stepSeconds;
    const startUnix = endUnix - seconds;

    const clusters = await this.clusters.find({
      where: { status: Not(ClusterStatus.DELETED) },
      order: { createdAt: 'DESC' },
    });

    const read = await Promise.all(
      clusters.map(async (cluster) => {
        try {
          const history = await this.prometheus.getMetricsHistory(
            cluster.id,
            startUnix,
            endUnix,
            step,
          );
          const nodes: NodeHistory[] = [...history.entries()].map(
            ([instance, node]) => ({
              ...node,
              server_id: node.server_id ?? instance,
            }),
          );
          return { cluster, nodes };
        } catch (err) {
          this.logger.warn(
            `No metrics read for cluster ${cluster.id}: ${(err as Error).message}`,
          );
          return { cluster, nodes: null };
        }
      }),
    );

    const rows: ClusterMetricsRow[] = read.map(({ cluster, nodes }) => {
      const series = nodes ? aggregateNodes(nodes) : [];
      const metrics: ClusterMetricsState = nodes
        ? stateOf(series, now, stepSeconds)
        : 'unavailable';
      const last = series.at(-1) ?? null;
      return {
        clusterId: cluster.id,
        name: cluster.name,
        provider: cluster.provider,
        clusterType: cluster.clusterType,
        status: cluster.status,
        metrics,
        nodesReporting: metrics === 'reporting' ? (last?.nodes ?? 0) : 0,
        lastSampleAt: last?.timestamp ?? null,
        current: metrics === 'reporting' ? last : null,
        series,
      };
    });

    const allNodes = read.flatMap(({ cluster, nodes }) =>
      (nodes ?? []).map((n) => ({
        ...n,
        server_id: `${cluster.id}/${n.server_id}`,
      })),
    );
    const fleetSeries = aggregateNodes(allNodes);
    const reporting = rows.filter((r) => r.metrics === 'reporting');

    return {
      window,
      step,
      rangeStart: new Date(startUnix * 1000).toISOString(),
      rangeEnd: new Date(endUnix * 1000).toISOString(),
      queriedAt: now.toISOString(),
      fleet: {
        clustersTotal: rows.length,
        clustersReporting: reporting.length,
        nodesReporting: reporting.reduce((s, r) => s + r.nodesReporting, 0),
        current: reporting.length ? (fleetSeries.at(-1) ?? null) : null,
        series: fleetSeries,
      },
      clusters: rows,
    };
  }
}
