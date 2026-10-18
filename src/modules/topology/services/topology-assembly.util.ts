import * as k8s from '@kubernetes/client-node';
import {
  ClusterEntity,
  isControlClusterType,
} from '../../infrastructure/clusters/entities/cluster.entity';
import { WireGuardPeerStatus } from '../../infrastructure/networking/entities/wireguard-peer.entity';
import { overlayDemotionOf } from '../../infrastructure/networking/kubeconfig-demotion';
import { nodeRoomInputs } from '../../infrastructure/scaling/engine/room-inputs';
import {
  TopologyAppDto,
  TopologyClusterDto,
  TopologyClusterLinkDto,
  TopologyLinkDto,
  TopologyProjectDto,
  TopologyResponseDto,
  TopologyServerDto,
  TopologyStackDto,
} from '../dto/topology.dto';
import {
  TopologyAppStatus,
  TopologyClusterType,
  TopologyFluiNetwork,
  TopologyHealthStatus,
} from '../enums/topology.enums';
import { overlayOf } from '../utils/topology-enrich.util';
import { WorkloadRefs } from '../utils/topology-links.util';
import { deriveClusterStatus } from './topology-k8s.helper';

export interface ClusterPart {
  cluster: ClusterEntity;
  reached: boolean;
  servers: TopologyServerDto[];
  apps: TopologyAppDto[];
  dropped: number;
  /** In-cluster hosts each workload's configuration names; used for links, never sent. */
  refs: WorkloadRefs[];
}

export interface TopologyParts {
  clusters: TopologyClusterDto[];
  servers: TopologyServerDto[];
  stacks: TopologyStackDto[];
  apps: TopologyAppDto[];
  droppedApps: number;
  links?: TopologyLinkDto[];
  clusterLinks?: TopologyClusterLinkDto[];
  projects?: TopologyProjectDto[];
}

export function fluiNetworkOf(
  status: WireGuardPeerStatus | undefined,
): TopologyFluiNetwork {
  if (status === WireGuardPeerStatus.ACTIVE) return TopologyFluiNetwork.ACTIVE;
  if (status === WireGuardPeerStatus.PENDING)
    return TopologyFluiNetwork.PENDING;
  if (status === WireGuardPeerStatus.STALE) return TopologyFluiNetwork.STALE;
  return TopologyFluiNetwork.NONE;
}

function percent(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

export function applyCapacity(
  servers: TopologyServerDto[],
  rooms: ReturnType<typeof nodeRoomInputs>,
): void {
  const byName = new Map(rooms.map((r) => [r.name, r]));
  for (const server of servers) {
    const room = byName.get(server.nodeName);
    if (!room) continue;
    server.capacity = {
      allocatableCpuM: room.allocatable.cpuMillicores,
      allocatableMemMi: room.allocatable.memoryMi,
      requestedCpuM: room.requested.cpuMillicores,
      requestedMemMi: room.requested.memoryMi,
      usedCpuPct: room.used
        ? percent(room.used.cpuMillicores, room.allocatable.cpuMillicores)
        : null,
      usedMemPct: room.used
        ? percent(room.used.memoryMi, room.allocatable.memoryMi)
        : null,
    };
  }
}

export function podMatchesSelector(
  pod: k8s.V1Pod,
  matchLabels: Record<string, string>,
): boolean {
  const podLabels = pod.metadata?.labels ?? {};
  return Object.entries(matchLabels).every(([k, v]) => podLabels[k] === v);
}

function clusterType(cluster: ClusterEntity): TopologyClusterType {
  if (cluster.clusterType === (TopologyClusterType.OBSERVABILITY as string)) {
    return TopologyClusterType.OBSERVABILITY;
  }
  return isControlClusterType(cluster.clusterType)
    ? TopologyClusterType.CONTROL
    : TopologyClusterType.WORKLOAD;
}

export function clusterDto(
  part: ClusterPart,
  stacks: TopologyStackDto[],
  network: {
    networkOn: boolean;
    member: boolean;
    inbound: TopologyClusterDto['inbound'];
  },
): TopologyClusterDto {
  const { cluster, servers, apps } = part;
  return {
    id: cluster.id,
    name: cluster.name,
    displayName: cluster.name,
    provider: cluster.provider,
    region: cluster.region,
    type: clusterType(cluster),
    status: part.reached
      ? deriveClusterStatus(servers, apps)
      : TopologyHealthStatus.DOWN,
    k3sVersion: cluster.k3sVersion ?? null,
    overlay: overlayOf({
      networkOn: network.networkOn,
      isControl: isControlClusterType(cluster.clusterType),
      held: !!overlayDemotionOf(cluster),
      member: network.member,
    }),
    counts: {
      apps: apps.length,
      stacks: stacks.filter((s) => s.clusterId === cluster.id).length,
      servers: servers.length,
      errors: apps.filter((a) => a.status === TopologyAppStatus.ERROR).length,
      warnings: apps.filter((a) => a.status === TopologyAppStatus.WARNING)
        .length,
    },
    inbound: network.inbound,
  };
}

export function assembleResponse(parts: TopologyParts): TopologyResponseDto {
  const { apps } = parts;
  return {
    version: '2',
    generatedAt: new Date().toISOString(),
    clusters: parts.clusters,
    servers: parts.servers,
    stacks: parts.stacks,
    apps,
    links: parts.links ?? [],
    clusterLinks: parts.clusterLinks ?? [],
    projects: parts.projects ?? [],
    stats: {
      totalClusters: parts.clusters.length,
      totalServers: parts.servers.length,
      totalStacks: parts.stacks.length,
      totalApps: apps.length,
      totalReplicas: apps.reduce((s, a) => s + a.replicaCount, 0),
      totalRamMB: apps.reduce((s, a) => s + a.ramRequestMB * a.replicaCount, 0),
      errorCount: apps.filter((a) => a.status === TopologyAppStatus.ERROR)
        .length,
      warningCount: apps.filter((a) => a.status === TopologyAppStatus.WARNING)
        .length,
      droppedApps: parts.droppedApps,
    },
  };
}

/** The work's answer, or a failure that says the cluster did not answer in time. */
export function answerWithin<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no answer within ${ms / 1000} s`)),
      ms,
    );
    work.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
