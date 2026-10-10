import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { AlertEventsService, IncomingAlert } from './alert-events.service';
import { AlertRoutingService } from './alert-routing.service';
import { PrometheusQueryService } from './prometheus-query.service';
import {
  includedMonthlyTrafficTb,
  TrafficWatchConfig,
  trafficWatchConfigFrom,
} from './traffic-watch.config';

const TB = 1e12;
const PREFIX = 'flui-traffic:';

export interface NodeTraffic {
  clusterId: string;
  node: string;
  /** Sustained over ten minutes, public interface only. */
  mbpsOut: number;
  mbpsIn: number;
  /** Outgoing bytes a month would carry at the pace of the last seven days. */
  monthPaceBytes: number;
  includedTb: number | null;
}

export interface EdgeTraffic {
  clusterId: string;
  rpsNow: number;
  rpsBefore: number;
  rateLimited10m: number;
  requests10m: number;
  serverErrors10m: number;
}

export interface TrafficReading {
  measuredAt: Date;
  nodes: NodeTraffic[];
  edges: EdgeTraffic[];
}

type Finding = Omit<IncomingAlert, 'status' | 'startsAt' | 'endsAt'>;

/**
 * What only arithmetic over the router's and the nodes' counters can tell:
 * a node's link filling up, the month's traffic heading past what the
 * provider includes, a surge of visitors, people being rate-limited, the
 * edge answering with errors. Raised by the API rather than by vmalert so the
 * thresholds come from the API's own settings and the provider of each node
 * is known.
 */
@Injectable()
export class TrafficWatchService {
  private readonly logger = new Logger(TrafficWatchService.name);
  readonly config: TrafficWatchConfig;

  constructor(
    configService: ConfigService,
    private readonly prometheus: PrometheusQueryService,
    private readonly alerts: AlertEventsService,
    private readonly routing: AlertRoutingService,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
  ) {
    this.config = trafficWatchConfigFrom((key) =>
      configService.get<string>(key),
    );
  }

  @Cron(process.env.FLUI_TRAFFIC_WATCH_CRON || '*/5 * * * *')
  async tick(): Promise<void> {
    try {
      await this.raise(findingsFor(await this.read(), this.config));
    } catch (error) {
      this.logger.warn(
        `Could not read traffic: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async read(): Promise<TrafficReading> {
    const nic = `device=~"${this.config.publicInterfaces}"`;
    const perNode = (metric: string) =>
      `avg_over_time(sum by (cluster_id, instance) (rate(${metric}{${nic}}[5m]))[10m:1m])`;
    const entry = 'traefik_entrypoint_requests_total{entrypoint="websecure"}';
    const [out, inn, pace, now, before, limited, total, failed, clusters] =
      await Promise.all([
        this.byLabels(perNode('node_network_transmit_bytes_total')),
        this.byLabels(perNode('node_network_receive_bytes_total')),
        this.byLabels(
          `sum by (cluster_id, instance) (increase_pure(node_network_transmit_bytes_total{${nic}}[7d])) / 7 * 30`,
        ),
        this.byLabels(`sum by (cluster_id) (rate(${entry}[5m]))`),
        this.byLabels(
          `avg_over_time(sum by (cluster_id) (rate(${entry}[5m]))[6h:5m] offset 15m)`,
        ),
        this.byLabels(
          `sum by (cluster_id) (increase_pure(traefik_entrypoint_requests_total{entrypoint="websecure",code="429"}[10m]))`,
        ),
        this.byLabels(`sum by (cluster_id) (increase_pure(${entry}[10m]))`),
        this.byLabels(
          `sum by (cluster_id) (increase_pure(traefik_entrypoint_requests_total{entrypoint="websecure",code=~"5.."}[10m]))`,
        ),
        this.clusters.find({
          select: { id: true, provider: true, region: true },
        }),
      ]);
    const where = new Map(clusters.map((c) => [c.id, c]));
    const nodes = [...out.keys()].map((key) => {
      const [clusterId, node] = key.split('|');
      const cluster = where.get(clusterId);
      return {
        clusterId,
        node,
        mbpsOut: ((out.get(key) ?? 0) * 8) / 1e6,
        mbpsIn: ((inn.get(key) ?? 0) * 8) / 1e6,
        monthPaceBytes: pace.get(key) ?? 0,
        includedTb:
          this.config.includedTrafficTb ??
          (cluster
            ? includedMonthlyTrafficTb(cluster.provider, cluster.region)
            : null),
      };
    });
    const edges = [...total.keys()].map((clusterId) => ({
      clusterId,
      rpsNow: now.get(clusterId) ?? 0,
      rpsBefore: before.get(clusterId) ?? 0,
      rateLimited10m: limited.get(clusterId) ?? 0,
      requests10m: total.get(clusterId) ?? 0,
      serverErrors10m: failed.get(clusterId) ?? 0,
    }));
    return { measuredAt: new Date(), nodes, edges };
  }

  /** Every finding is repeated while it holds; anything open and no longer found is closed. */
  private async raise(findings: Finding[]): Promise<void> {
    const open = await this.alerts.openEpisodes(PREFIX);
    const now = new Date();
    const incoming: IncomingAlert[] = findings.map((f) => ({
      ...f,
      status: 'firing',
      startsAt: open.get(f.fingerprint) ?? now,
      endsAt: null,
    }));
    const found = new Set(findings.map((f) => f.fingerprint));
    for (const [fingerprint, startsAt] of open) {
      if (found.has(fingerprint)) continue;
      incoming.push({
        fingerprint,
        status: 'resolved',
        startsAt,
        endsAt: now,
        alertname: alertnameOf(fingerprint),
        severity: 'warning',
        labels: {},
        annotations: { summary: resolvedSummaryOf(fingerprint) },
      });
    }
    if (incoming.length === 0) return;
    for (const { kind, event } of await this.alerts.record(incoming)) {
      await this.routing.deliver(kind, event, { ownerUserId: null });
    }
  }

  private async byLabels(query: string): Promise<Map<string, number>> {
    const response = await this.prometheus.queryInstant(query);
    const values = new Map<string, number>();
    for (const series of response.data?.result ?? []) {
      const m = series.metric ?? {};
      const key = m.instance
        ? `${m.cluster_id ?? ''}|${m.instance}`
        : (m.cluster_id ?? '');
      const value = Number(series.value?.[1]);
      if (Number.isFinite(value)) values.set(key, value);
    }
    return values;
  }
}

const ALERTNAMES: Record<string, string> = {
  bandwidth: 'FluiNodeBandwidthHigh',
  month: 'FluiNodeMonthlyTrafficHigh',
  surge: 'FluiTrafficSurge',
  limited: 'FluiRequestsRateLimited',
  errors: 'FluiEdgeServerErrors',
};

const RESOLVED: Record<string, string> = {
  bandwidth: "A node's bandwidth is back under the alert",
  month: "A node's monthly traffic pace is back under the alert",
  surge: 'Requests are back to their usual pace',
  limited: 'Requests are no longer being turned away by a rate limit',
  errors: 'Server errors are back under the alert',
};

const kindOf = (fingerprint: string): string =>
  fingerprint.slice(PREFIX.length).split(':')[0];

const resolvedSummaryOf = (fingerprint: string): string =>
  RESOLVED[kindOf(fingerprint)] ?? 'Back under the alert';

const alertnameOf = (fingerprint: string): string =>
  ALERTNAMES[kindOf(fingerprint)] ?? 'FluiTrafficWatch';

const round = (n: number, digits = 0): string => n.toFixed(digits);

/** The recorder keeps fingerprints to 64 characters; a cluster id and a node name alone pass that. */
const fingerprintOf = (kind: string, ...subject: string[]): string =>
  `${PREFIX}${kind}:${createHash('sha256').update(subject.join('|')).digest('hex').slice(0, 20)}`;

/** The conditions, kept apart from the reading so they can be checked on their own. */
export { fingerprintOf };

function nodeFindings(
  n: TrafficReading['nodes'][number],
  config: TrafficWatchConfig,
): Finding[] {
  const findings: Finding[] = [];
  const busiest = Math.max(n.mbpsOut, n.mbpsIn);
  if (config.nodeMbps > 0 && busiest >= config.nodeMbps) {
    findings.push({
      fingerprint: fingerprintOf('bandwidth', n.clusterId, n.node),
      alertname: ALERTNAMES.bandwidth,
      severity: 'warning',
      fluiKind: 'node',
      clusterId: n.clusterId,
      nodeInstance: n.node,
      labels: { node: n.node },
      annotations: {
        summary: `Node ${n.node} has carried ${round(busiest)} Mbit/s for ten minutes (${round(n.mbpsOut)} out, ${round(n.mbpsIn)} in)`,
        description: `Above the ${config.nodeMbps} Mbit/s alert. Pages and image pulls through it slow down once its link is full.`,
        action:
          'Spread the load: another node for the applications on it, or the image registry on a node of its own.',
      },
    });
  }
  if (n.includedTb && config.monthlyTrafficPercent > 0) {
    const share = (n.monthPaceBytes / (n.includedTb * TB)) * 100;
    if (share >= config.monthlyTrafficPercent) {
      findings.push({
        fingerprint: fingerprintOf('month', n.clusterId, n.node),
        alertname: ALERTNAMES.month,
        severity: 'warning',
        fluiKind: 'node',
        clusterId: n.clusterId,
        nodeInstance: n.node,
        labels: { node: n.node },
        annotations: {
          summary: `At this week's pace node ${n.node} sends ${round(n.monthPaceBytes / TB, 1)} TB this month, ${round(share)}% of the ${n.includedTb} TB its provider includes`,
          description:
            'What goes over is billed by the provider, or slows the node down, depending on the provider.',
          action:
            'Check what is sending: the registry traffic and the busiest applications.',
        },
      });
    }
  }
  return findings;
}

function edgeFindings(
  e: TrafficReading['edges'][number],
  config: TrafficWatchConfig,
): Finding[] {
  const findings: Finding[] = [];
  if (
    config.spikeFactor > 0 &&
    e.rpsNow >= config.spikeMinRps &&
    e.rpsNow >= config.spikeFactor * Math.max(e.rpsBefore, 0.01)
  ) {
    findings.push({
      fingerprint: fingerprintOf('surge', e.clusterId),
      alertname: ALERTNAMES.surge,
      severity: 'warning',
      fluiKind: 'traffic',
      clusterId: e.clusterId,
      labels: {},
      annotations: {
        summary: `Requests are arriving at ${round(e.rpsNow, 1)} a second, ${round(e.rpsNow / Math.max(e.rpsBefore, 0.01))} times the last hours`,
        description:
          'A surge of visitors. Watch memory, CPU and refused requests over the next minutes.',
        action: 'flui scaling why',
      },
    });
  }
  if (
    config.rateLimitedPer10m > 0 &&
    e.rateLimited10m >= config.rateLimitedPer10m
  ) {
    findings.push({
      fingerprint: fingerprintOf('limited', e.clusterId),
      alertname: ALERTNAMES.limited,
      severity: 'warning',
      fluiKind: 'traffic',
      clusterId: e.clusterId,
      labels: {},
      annotations: {
        summary: `${round(e.rateLimited10m)} requests were turned away by a rate limit in ten minutes`,
        description:
          'Either someone is hammering the installation, or the limits are too tight for the visitors it has.',
      },
    });
  }
  const errorShare =
    e.requests10m > 0 ? (e.serverErrors10m / e.requests10m) * 100 : 0;
  if (
    config.edgeErrorPercent > 0 &&
    e.requests10m >= config.edgeErrorMinRequests &&
    errorShare >= config.edgeErrorPercent
  ) {
    findings.push({
      fingerprint: fingerprintOf('errors', e.clusterId),
      alertname: ALERTNAMES.errors,
      severity: 'critical',
      fluiKind: 'traffic',
      clusterId: e.clusterId,
      labels: {},
      annotations: {
        summary: `${round(errorShare, 1)}% of requests got a server error in ten minutes (${round(e.serverErrors10m)} of ${round(e.requests10m)})`,
        description:
          'Visitors are seeing errors. The applications or platform components behind them may be out of memory, restarting or overloaded.',
      },
    });
  }
  return findings;
}

export function findingsFor(
  reading: TrafficReading,
  config: TrafficWatchConfig,
): Finding[] {
  return [
    ...reading.nodes.flatMap((n) => nodeFindings(n, config)),
    ...reading.edges.flatMap((e) => edgeFindings(e, config)),
  ];
}
