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
  TopologyClusterDto,
  TopologyServerDto,
} from '../dto/topology.dto';

export interface TopologyChange {
  event: TopologyEventType;
  data: unknown;
}

const HEARTBEAT_MS = 15_000;
const POLL_INTERVAL_MS = 10_000;
const MOCK_FLIP_INTERVAL_MS = 30_000;
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
  private mockTimer?: NodeJS.Timeout;

  private lastSnapshot: Map<string, TopologyAppDto> = new Map();
  private lastServers: Map<string, TopologyServerDto> = new Map();
  private readonly debouncedStatus: Map<
    string,
    { status: TopologyAppStatus; reason: string | null; timer: NodeJS.Timeout }
  > = new Map();

  readonly changes$: Observable<TopologyChange> = merge(
    this.heartbeat$,
    new Observable<TopologyChange>((subscriber) => {
      const sub = this.subject.subscribe(subscriber);
      return () => sub.unsubscribe();
    }),
  );

  constructor(private readonly topologyService: TopologyService) {}

  /**
   * Started, never awaited: this runs before `app.listen()` and calls every
   * cluster's API. A powered-off host swallows the packets for ~133s against a
   * liveness probe that kills at 90. The poll below refreshes on its own.
   */
  onModuleInit(): void {
    if (this.topologyService.isMockMode()) {
      this.startMockEmitter();
      return;
    }
    void this.refreshSnapshot().catch((err: Error) => {
      this.logger.error(`First topology snapshot failed: ${err.message}`);
    });
    this.pollTimer = setInterval(() => {
      this.refreshSnapshot().catch((err) =>
        this.logger.error(`Topology poll failed: ${(err as Error).message}`),
      );
    }, POLL_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.mockTimer) clearInterval(this.mockTimer);
    for (const { timer } of this.debouncedStatus.values()) {
      clearTimeout(timer);
    }
    this.debouncedStatus.clear();
    this.subject.complete();
  }

  private async refreshSnapshot(): Promise<void> {
    const topology = await this.topologyService.buildTopology();
    const newApps = new Map<string, TopologyAppDto>();
    const newServers = new Map<string, TopologyServerDto>();

    for (const cluster of topology.clusters) {
      for (const server of cluster.servers) {
        newServers.set(scopedKey(cluster.id, server.id), server);
      }
      for (const app of cluster.apps) {
        newApps.set(app.id, app);
      }
    }

    this.diffAndEmit(newApps, newServers, topology.clusters);

    this.lastSnapshot = newApps;
    this.lastServers = newServers;
  }

  private diffAndEmit(
    newApps: Map<string, TopologyAppDto>,
    newServers: Map<string, TopologyServerDto>,
    clusters: TopologyClusterDto[],
  ): void {
    for (const [id, app] of newApps) {
      const prev = this.lastSnapshot.get(id);
      if (!prev) {
        this.subject.next({
          event: TopologyEventType.APP_DEPLOYED,
          data: app,
        });
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
        this.subject.next({
          event: TopologyEventType.APP_SCALED,
          data: {
            appId: app.id,
            replicas: app.replicas,
            replicaCount: app.replicaCount,
            scalingNote: app.scalingNote,
          },
        });
      }
    }

    for (const id of this.lastSnapshot.keys()) {
      if (!newApps.has(id)) {
        this.subject.next({
          event: TopologyEventType.APP_REMOVED,
          data: { appId: id },
        });
      }
    }

    const clusterByServerKey = new Map<string, string>();
    for (const c of clusters) {
      for (const s of c.servers) {
        clusterByServerKey.set(scopedKey(c.id, s.id), c.id);
      }
    }
    for (const [key, server] of newServers) {
      if (!this.lastServers.has(key)) {
        const clusterId = clusterByServerKey.get(key);
        if (clusterId) {
          this.subject.next({
            event: TopologyEventType.SERVER_ADDED,
            data: { clusterId, server },
          });
        }
      }
    }
    for (const [key, server] of this.lastServers) {
      if (!newServers.has(key)) {
        const [clusterId] = key.split('::');
        this.subject.next({
          event: TopologyEventType.SERVER_REMOVED,
          data: { clusterId, serverId: server.id },
        });
      }
    }
  }

  private queueStatusChange(app: TopologyAppDto): void {
    const existing = this.debouncedStatus.get(app.id);
    if (existing) clearTimeout(existing.timer);

    const timer = setTimeout(() => {
      this.debouncedStatus.delete(app.id);
      this.subject.next({
        event: TopologyEventType.APP_STATUS_CHANGED,
        data: {
          appId: app.id,
          status: app.status,
          statusReason: app.statusReason,
        },
      });
    }, STATUS_DEBOUNCE_MS);

    this.debouncedStatus.set(app.id, {
      status: app.status,
      reason: app.statusReason,
      timer,
    });
  }

  private startMockEmitter(): void {
    this.refreshSnapshot().catch((err) =>
      this.logger.error(
        `Mock topology snapshot failed: ${(err as Error).message}`,
      ),
    );

    const statuses: TopologyAppStatus[] = [
      TopologyAppStatus.RUNNING,
      TopologyAppStatus.WARNING,
      TopologyAppStatus.ERROR,
    ];
    const reasons: Record<TopologyAppStatus, string | null> = {
      [TopologyAppStatus.RUNNING]: null,
      [TopologyAppStatus.WARNING]: 'Restart spike',
      [TopologyAppStatus.ERROR]: 'CrashLoopBackOff',
      [TopologyAppStatus.STOPPED]: null,
    };

    this.mockTimer = setInterval(() => {
      const ids = [...this.lastSnapshot.keys()];
      if (ids.length === 0) return;
      const id = ids[Math.floor(Math.random() * ids.length)];
      const status = statuses[Math.floor(Math.random() * statuses.length)];
      this.subject.next({
        event: TopologyEventType.APP_STATUS_CHANGED,
        data: { appId: id, status, statusReason: reasons[status] },
      });
    }, MOCK_FLIP_INTERVAL_MS);
  }
}

function scopedKey(clusterId: string, serverId: string): string {
  return `${clusterId}::${serverId}`;
}

function sameReplicaPlacement(a: TopologyAppDto, b: TopologyAppDto): boolean {
  if (a.replicas.length !== b.replicas.length) return false;
  const aMap = new Map(a.replicas.map((r) => [r.serverId, r.count]));
  for (const r of b.replicas) {
    if (aMap.get(r.serverId) !== r.count) return false;
  }
  return true;
}
