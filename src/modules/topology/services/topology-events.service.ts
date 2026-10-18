import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Subject, Observable, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';
import { TopologyService } from './topology.service';
import { TopologyAppStatus, TopologyEventType } from '../enums/topology.enums';
import {
  TopologyAppDto,
  TopologyResponseDto,
  TopologyServerCapacityChangeDto,
  TopologyServerDto,
  TopologyStreamPayloadDto,
} from '../dto/topology.dto';

export interface TopologyChange {
  event: TopologyEventType;
  data: TopologyStreamPayloadDto;
}

const HEARTBEAT_MS = 15_000;
const POLL_INTERVAL_MS = 10_000;
/** Someone asked within this long, or holds a stream open: the map is kept fresh. */
const WATCHED_FOR_MS = 2 * 60_000;
/** Older than this, a snapshot is rebuilt before it is served (once, for everyone asking). */
const STALE_AFTER_MS = 2 * 60_000;
const CAPACITY_EVERY_MS = 30_000;
const STATUS_DEBOUNCE_MS = 1_000;

@Injectable()
export class TopologyEventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TopologyEventsService.name);
  private readonly subject = new Subject<TopologyChange>();
  private readonly heartbeat$ = interval(HEARTBEAT_MS).pipe(
    map<number, TopologyChange>(() => ({
      event: TopologyEventType.HEARTBEAT,
      data: { ts: new Date().toISOString() },
    })),
  );

  private pollTimer?: NodeJS.Timeout;
  private latest?: TopologyResponseDto;
  private latestAt = 0;
  private building?: Promise<TopologyResponseDto>;
  private watchers = 0;
  private askedAt = 0;
  private stopped = false;
  private apps = new Map<string, TopologyAppDto>();
  private servers = new Map<string, TopologyServerDto>();
  private sentCapacity = new Map<string, string>();
  private sentLinks = '';
  private capacitySentAt = 0;
  private readonly debouncedStatus = new Map<string, NodeJS.Timeout>();

  readonly changes$: Observable<TopologyChange> =
    new Observable<TopologyChange>((subscriber) => {
      this.watchers += 1;
      this.schedule();
      const sub = merge(this.heartbeat$, this.subject).subscribe(subscriber);
      return () => {
        this.watchers -= 1;
        sub.unsubscribe();
      };
    });

  constructor(private readonly topologyService: TopologyService) {}

  /**
   * Started, never awaited: this runs before `app.listen()` and calls every
   * cluster's API. A powered-off host swallows the packets for ~133s against a
   * liveness probe that kills at 90. The poll below refreshes on its own.
   */
  onModuleInit(): void {
    void this.refresh().catch((err: Error) => {
      this.logger.error(`First topology snapshot failed: ${err.message}`);
    });
    this.schedule();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    for (const timer of this.debouncedStatus.values()) clearTimeout(timer);
    this.debouncedStatus.clear();
    this.subject.complete();
  }

  /**
   * The shared snapshot every caller is served from: never one cluster read
   * per request. A stale one is rebuilt first, by one build all callers wait on.
   */
  async snapshot(): Promise<TopologyResponseDto> {
    this.askedAt = Date.now();
    this.schedule();
    if (this.latest && Date.now() - this.latestAt < STALE_AFTER_MS) {
      return this.latest;
    }
    return this.refresh();
  }

  /** Clusters are read again only while someone looks at the map. */
  private watched(): boolean {
    return this.watchers > 0 || Date.now() - this.askedAt < WATCHED_FOR_MS;
  }

  /** The next poll starts after the last one ends, so slow clusters never pile builds up. */
  private schedule(): void {
    if (this.stopped || this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      if (!this.watched()) return;
      this.refresh()
        .catch((err: Error) =>
          this.logger.error(`Topology poll failed: ${err.message}`),
        )
        .finally(() => this.schedule());
    }, POLL_INTERVAL_MS);
  }

  /** One build at a time; whoever asks meanwhile gets the one in flight. */
  private refresh(): Promise<TopologyResponseDto> {
    this.building ??= this.refreshSnapshot().finally(() => {
      this.building = undefined;
    });
    return this.building;
  }

  private async refreshSnapshot(): Promise<TopologyResponseDto> {
    const topology = await this.topologyService.buildTopology();
    const apps = new Map(topology.apps.map((a) => [a.id, a]));
    const servers = new Map(topology.servers.map((s) => [s.id, s]));
    // The first snapshot is the baseline, not news: diffing it against an
    // empty one would announce every app as just deployed.
    if (this.latest) {
      this.diffApps(apps);
      this.diffServers(servers);
      this.emitPeriodic(topology);
    } else {
      this.rememberCapacity(topology.servers);
      this.sentLinks = linksKey(topology);
    }
    this.latest = topology;
    this.latestAt = Date.now();
    this.apps = apps;
    this.servers = servers;
    return topology;
  }

  private emit(event: TopologyEventType, data: TopologyStreamPayloadDto): void {
    this.subject.next({ event, data });
  }

  private diffApps(next: Map<string, TopologyAppDto>): void {
    for (const [id, app] of next) {
      const prev = this.apps.get(id);
      if (!prev) {
        this.emit(TopologyEventType.APP_DEPLOYED, { app });
        continue;
      }
      if (
        prev.status !== app.status ||
        prev.statusReason !== app.statusReason
      ) {
        this.queueStatusChange(app);
      }
      if (
        prev.replicaCount !== app.replicaCount ||
        !sameReplicaPlacement(prev, app)
      ) {
        this.emit(TopologyEventType.APP_SCALED, {
          appId: app.id,
          clusterId: app.clusterId,
          replicas: app.replicas,
          replicaCount: app.replicaCount,
          scalingNote: app.scalingNote,
        });
      }
    }
    for (const [id, app] of this.apps) {
      if (!next.has(id)) {
        this.emit(TopologyEventType.APP_REMOVED, {
          appId: id,
          clusterId: app.clusterId,
        });
      }
    }
  }

  private diffServers(next: Map<string, TopologyServerDto>): void {
    for (const [id, server] of next) {
      if (!this.servers.has(id)) {
        this.emit(TopologyEventType.SERVER_ADDED, {
          clusterId: server.clusterId,
          server,
        });
      }
    }
    for (const [id, server] of this.servers) {
      if (!next.has(id)) {
        this.emit(TopologyEventType.SERVER_REMOVED, {
          clusterId: server.clusterId,
          serverId: id,
        });
      }
    }
  }

  /** Capacity and links move every poll; they are sent every 30 s, and only when they changed. */
  private emitPeriodic(topology: TopologyResponseDto): void {
    if (Date.now() - this.capacitySentAt < CAPACITY_EVERY_MS) return;
    const changed = topology.servers.filter(
      (s) => this.sentCapacity.get(s.id) !== capacityKey(s),
    );
    this.rememberCapacity(topology.servers);
    if (changed.length) {
      this.emit(TopologyEventType.SERVER_CAPACITY, {
        capacities: changed.map(capacityChange),
      });
    }
    const links = linksKey(topology);
    if (links !== this.sentLinks) {
      this.sentLinks = links;
      this.emit(TopologyEventType.LINKS_CHANGED, {
        links: topology.links,
        clusterLinks: topology.clusterLinks,
      });
    }
  }

  private rememberCapacity(servers: TopologyServerDto[]): void {
    this.capacitySentAt = Date.now();
    this.sentCapacity = new Map(servers.map((s) => [s.id, capacityKey(s)]));
  }

  private queueStatusChange(app: TopologyAppDto): void {
    const existing = this.debouncedStatus.get(app.id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.debouncedStatus.delete(app.id);
      this.emit(TopologyEventType.APP_STATUS_CHANGED, {
        appId: app.id,
        clusterId: app.clusterId,
        status: app.status as TopologyAppStatus,
        statusReason: app.statusReason,
      });
    }, STATUS_DEBOUNCE_MS);
    this.debouncedStatus.set(app.id, timer);
  }
}

export function capacityChange(
  server: TopologyServerDto,
): TopologyServerCapacityChangeDto {
  return {
    serverId: server.id,
    clusterId: server.clusterId,
    capacity: server.capacity,
    podCount: server.podCount,
  };
}

function linksKey(topology: TopologyResponseDto): string {
  return JSON.stringify([topology.links, topology.clusterLinks]);
}

function capacityKey(server: TopologyServerDto): string {
  return JSON.stringify([server.capacity, server.podCount]);
}

function sameReplicaPlacement(a: TopologyAppDto, b: TopologyAppDto): boolean {
  if (a.replicas.length !== b.replicas.length) return false;
  const aMap = new Map(a.replicas.map((r) => [r.serverId, r.count]));
  return b.replicas.every((r) => aMap.get(r.serverId) === r.count);
}
