import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { SandboxWaitlistEntity } from '../../sandbox/entities/sandbox-waitlist.entity';
import { SandboxCapacityService } from '../../sandbox/services/sandbox-capacity.service';
import {
  RegistryTraffic,
  RegistryTrafficService,
} from '../../flui-registry/services/registry-traffic.service';
import { AlertEventEntity } from '../entities/alert-event.entity';
import { PrometheusQueryService } from './prometheus-query.service';
import {
  EdgeTraffic,
  NodeTraffic,
  TrafficWatchService,
} from './traffic-watch.service';
import { TrafficWatchConfig } from './traffic-watch.config';

const PLATFORM_NAMESPACES = 'flui-system|flui-control';

export interface NodeNow extends NodeTraffic {
  clusterName: string;
  cpuPercent: number | null;
  memoryPercent: number | null;
}

export interface EdgeNow extends EdgeTraffic {
  clusterName: string;
}

export interface PlatformComponentNow {
  name: string;
  /** Of its limit; null when it has none. */
  cpuPercent: number | null;
  memoryPercent: number | null;
  restartsLastHour: number;
}

export interface SandboxNow {
  live: number;
  warm: number;
  ceiling: number;
  waiting: number;
  fullRefusals: number;
}

export interface InstallationNow {
  measuredAt: Date;
  nodes: NodeNow[];
  edges: EdgeNow[];
  platform: PlatformComponentNow[];
  registry: RegistryTraffic | null;
  sandbox: SandboxNow | null;
  alerts: { firing: number; critical: number; names: string[] };
  thresholds: Pick<
    TrafficWatchConfig,
    | 'nodeMbps'
    | 'monthlyTrafficPercent'
    | 'spikeFactor'
    | 'spikeMinRps'
    | 'rateLimitedPer10m'
    | 'edgeErrorPercent'
  >;
}

/**
 * One reading of everything that runs out first under a crowd: the nodes'
 * CPU, memory and links, the requests at each cluster's door, the platform's
 * own components, the image registry and the demo's spaces. What the launch
 * screen, `flui now` and the agent tool all show, computed here once.
 */
@Injectable()
export class InstallationNowService {
  private readonly logger = new Logger(InstallationNowService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly prometheus: PrometheusQueryService,
    private readonly traffic: TrafficWatchService,
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(AlertEventEntity)
    private readonly alertEvents: Repository<AlertEventEntity>,
    @InjectRepository(SandboxWaitlistEntity)
    private readonly waitlist: Repository<SandboxWaitlistEntity>,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  async read(): Promise<InstallationNow> {
    const [
      reading,
      cpu,
      memory,
      platform,
      clusters,
      firing,
      registry,
      sandbox,
    ] = await Promise.all([
      this.traffic.read(),
      this.byNode(
        '(1 - avg by (cluster_id, instance) (rate(node_cpu_seconds_total{mode="idle"}[5m]))) * 100',
      ),
      this.byNode(
        '(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes) * 100',
      ),
      this.platform(),
      this.clusters.find({ select: { id: true, name: true } }),
      this.alertEvents.find({
        where: { status: 'firing' },
        select: { alertname: true, severity: true },
      }),
      this.registry(),
      this.sandbox(),
    ]);
    const nameOf = new Map(clusters.map((c) => [c.id, c.name]));
    const {
      nodeMbps,
      monthlyTrafficPercent,
      spikeFactor,
      spikeMinRps,
      rateLimitedPer10m,
      edgeErrorPercent,
    } = this.traffic.config;
    return {
      measuredAt: reading.measuredAt,
      nodes: reading.nodes.map((n) => ({
        ...n,
        clusterName: nameOf.get(n.clusterId) ?? n.clusterId,
        cpuPercent: cpu.get(`${n.clusterId}|${n.node}`) ?? null,
        memoryPercent: memory.get(`${n.clusterId}|${n.node}`) ?? null,
      })),
      edges: reading.edges.map((e) => ({
        ...e,
        clusterName: nameOf.get(e.clusterId) ?? e.clusterId,
      })),
      platform,
      registry,
      sandbox,
      alerts: {
        firing: firing.length,
        critical: firing.filter((a) => a.severity === 'critical').length,
        names: [...new Set(firing.map((a) => a.alertname))].sort((a, b) =>
          a.localeCompare(b),
        ),
      },
      thresholds: {
        nodeMbps,
        monthlyTrafficPercent,
        spikeFactor,
        spikeMinRps,
        rateLimitedPer10m,
        edgeErrorPercent,
      },
    };
  }

  private async platform(): Promise<PlatformComponentNow[]> {
    const where = `{namespace=~"${PLATFORM_NAMESPACES}"}`;
    const [cpu, memory, restarts] = await Promise.all([
      this.byName(`flui:app_cpu_utilization_percent${where}`),
      this.byName(`flui:app_memory_utilization_percent${where}`),
      this.byName(`flui:app_restart_rate_1h${where}`),
    ]);
    const names = new Set([...cpu.keys(), ...memory.keys()]);
    return [...names]
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        name,
        cpuPercent: cpu.get(name) ?? null,
        memoryPercent: memory.get(name) ?? null,
        restartsLastHour: Math.round(restarts.get(name) ?? 0),
      }));
  }

  private async registry(): Promise<RegistryTraffic | null> {
    if (this.config.get<string>('FLUI_IMAGE_REGISTRY')?.trim() !== 'flui') {
      return null;
    }
    const service = this.moduleRef?.get(RegistryTrafficService, {
      strict: false,
    });
    return service ? this.quietly(service.traffic('1h')) : null;
  }

  private async sandbox(): Promise<SandboxNow | null> {
    if (this.config.get<string>('SANDBOX_ENABLED') !== 'true') return null;
    const capacity = this.moduleRef?.get(SandboxCapacityService, {
      strict: false,
    });
    if (!capacity) return null;
    const [snapshot, waiting] = await Promise.all([
      this.quietly(capacity.snapshot()),
      this.waitlist.count({ where: { offeredAt: IsNull() } }),
    ]);
    if (!snapshot) return null;
    return {
      live: snapshot.live,
      warm: snapshot.warm,
      ceiling: snapshot.ceiling,
      waiting,
      fullRefusals: snapshot.fullRefusals,
    };
  }

  /** A part that cannot be read leaves its section empty rather than the whole screen. */
  private async quietly<T>(work: Promise<T>): Promise<T | null> {
    try {
      return await work;
    } catch (error) {
      this.logger.warn(
        `Part of the reading failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async byNode(query: string): Promise<Map<string, number>> {
    const response = await this.prometheus.queryInstant(query);
    return new Map(
      (response.data?.result ?? []).map((s) => [
        `${s.metric?.cluster_id ?? ''}|${s.metric?.instance ?? ''}`,
        Number(s.value?.[1]),
      ]),
    );
  }

  private async byName(query: string): Promise<Map<string, number>> {
    const response = await this.prometheus.queryInstant(query);
    const values = new Map<string, number>();
    for (const s of response.data?.result ?? []) {
      const name = s.metric?.label_app_kubernetes_io_name;
      const value = Number(s.value?.[1]);
      if (name && Number.isFinite(value)) values.set(name, value);
    }
    return values;
  }
}
