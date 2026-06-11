import * as k8s from '@kubernetes/client-node';
import {
  PodPlacement,
  resolvePrimaryServerId,
  statefulSetOrdinal,
} from '../utils/primary-server.util';
import { PodStatusSummary, deriveAppStatus } from '../utils/app-status.util';
import {
  TopologyAppCategory,
  TopologyAppKind,
  TopologyAppStatus,
  TopologyHealthStatus,
  TopologyScalingMode,
  TopologyServerRole,
} from '../enums/topology.enums';
import {
  TopologyAppDto,
  TopologyAppReplicaDto,
  TopologyClusterDto,
  TopologyServerDto,
} from '../dto/topology.dto';
import { makeTopologySlug } from '../utils/slug.util';
import {
  resolveTopologyCategory,
  resolveTopologyKind,
} from '../utils/category.util';

export const FLUI_MANAGED_LABEL_SELECTOR =
  'app.kubernetes.io/managed-by=flui-cloud';

export interface ClusterContext {
  id: string;
  name: string;
  displayName: string;
  provider: string;
  region: string;
  controlPlaneNodeNames: Set<string>;
}

export function mapNodesToServers(
  nodes: k8s.V1Node[],
  ctx: ClusterContext,
): TopologyServerDto[] {
  return nodes.map((n) => {
    const name = n.metadata?.name ?? '';
    const isControlPlane =
      ctx.controlPlaneNodeNames.has(name) ||
      Boolean(n.metadata?.labels?.['node-role.kubernetes.io/control-plane']) ||
      Boolean(n.metadata?.labels?.['node-role.kubernetes.io/master']);

    const cpuStr = n.status?.capacity?.['cpu'] ?? '0';
    const memStr = n.status?.capacity?.['memory'] ?? '0';
    const storageStr = n.status?.capacity?.['ephemeral-storage'] ?? '0';

    return {
      id: name,
      name,
      displayName: name,
      role: isControlPlane
        ? TopologyServerRole.CONTROL_PLANE
        : TopologyServerRole.WORKER,
      status: nodeReadyToHealth(n),
      specs: {
        cpuCores: parseCpuCores(cpuStr),
        memoryMB: Math.round(parseMemoryBytes(memStr) / (1024 * 1024)),
        storageGB: Math.round(
          parseMemoryBytes(storageStr) / (1024 * 1024 * 1024),
        ),
      },
    };
  });
}

function nodeReadyToHealth(node: k8s.V1Node): TopologyHealthStatus {
  const ready = node.status?.conditions?.find((c) => c.type === 'Ready');
  if (ready?.status === 'True') return TopologyHealthStatus.HEALTHY;
  if (ready?.status === 'False') return TopologyHealthStatus.DOWN;
  return TopologyHealthStatus.DEGRADED;
}

function parseCpuCores(s: string): number {
  if (!s) return 0;
  if (s.endsWith('m')) return Number.parseInt(s.slice(0, -1), 10) / 1000;
  return Number.parseFloat(s);
}

function parseMemoryBytes(s: string): number {
  if (!s) return 0;
  const m = /^(\d+(?:\.\d+)?)([A-Za-z]*)$/.exec(s);
  if (!m) return 0;
  const value = Number.parseFloat(m[1]);
  const unit = m[2];
  const map: Record<string, number> = {
    '': 1,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    K: 1000,
    M: 1000 ** 2,
    G: 1000 ** 3,
    T: 1000 ** 4,
  };
  return value * (map[unit] ?? 1);
}

export function parseCpuMillicores(s?: string | null): number {
  if (!s) return 0;
  if (s.endsWith('m')) return Number.parseInt(s.slice(0, -1), 10);
  return Math.round(Number.parseFloat(s) * 1000);
}

export function parseMemoryMB(s?: string | null): number {
  if (!s) return 0;
  return Math.round(parseMemoryBytes(s) / (1024 * 1024));
}

interface WorkloadDescriptor {
  appId: string;
  name: string;
  displayName: string;
  namespace: string;
  scalingMode: TopologyScalingMode;
  declaredKind: string | null;
  declaredCategory: string | null;
  desiredReplicas: number;
  ramRequestMB: number;
  ramLimitMB: number;
  cpuRequestM: number;
  cpuLimitM: number;
  selectorMatchLabels: Record<string, string>;
  labels: Record<string, string>;
  hpaEnabled: boolean;
  scalingNote: string | null;
}

export function describeDeployment(d: k8s.V1Deployment): WorkloadDescriptor {
  return describeWorkload({
    spec: d.spec ?? {},
    metadata: d.metadata,
    scalingMode: TopologyScalingMode.MANUAL,
    desiredReplicas: d.spec?.replicas ?? 0,
  });
}

export function describeStatefulSet(s: k8s.V1StatefulSet): WorkloadDescriptor {
  return describeWorkload({
    spec: s.spec ?? {},
    metadata: s.metadata,
    scalingMode: TopologyScalingMode.STATEFULSET,
    desiredReplicas: s.spec?.replicas ?? 0,
  });
}

export function describeDaemonSet(d: k8s.V1DaemonSet): WorkloadDescriptor {
  return describeWorkload({
    spec: d.spec ?? {},
    metadata: d.metadata,
    scalingMode: TopologyScalingMode.DAEMONSET,
    desiredReplicas: d.status?.desiredNumberScheduled ?? 0,
  });
}

interface DescribeArgs {
  spec: {
    template?: k8s.V1PodTemplateSpec;
    selector?: k8s.V1LabelSelector;
  };
  metadata?: k8s.V1ObjectMeta;
  scalingMode: TopologyScalingMode;
  desiredReplicas: number;
}

function describeWorkload(args: DescribeArgs): WorkloadDescriptor {
  const meta = args.metadata ?? {};
  const labels = meta.labels ?? {};
  const containers = args.spec.template?.spec?.containers ?? [];

  let cpuRequestM = 0;
  let cpuLimitM = 0;
  let ramRequestMB = 0;
  let ramLimitMB = 0;
  for (const c of containers) {
    cpuRequestM += parseCpuMillicores(c.resources?.requests?.['cpu']);
    cpuLimitM += parseCpuMillicores(c.resources?.limits?.['cpu']);
    ramRequestMB += parseMemoryMB(c.resources?.requests?.['memory']);
    ramLimitMB += parseMemoryMB(c.resources?.limits?.['memory']);
  }

  const appId =
    labels['flui-app-id'] ??
    `${meta.namespace ?? 'default'}/${meta.name ?? ''}`;
  const name = meta.name ?? appId;
  const displayName = meta.annotations?.['flui.cloud/display-name'] ?? name;

  return {
    appId,
    name,
    displayName,
    namespace: meta.namespace ?? 'default',
    scalingMode: args.scalingMode,
    declaredKind: labels['flui.cloud/app-kind'] ?? null,
    declaredCategory: labels['flui.cloud/app-category'] ?? null,
    desiredReplicas: args.desiredReplicas,
    ramRequestMB,
    ramLimitMB,
    cpuRequestM,
    cpuLimitM,
    selectorMatchLabels: args.spec.selector?.matchLabels ?? {},
    labels,
    hpaEnabled: false,
    scalingNote: null,
  };
}

export function summarizePod(pod: k8s.V1Pod): PodStatusSummary {
  const containerStatuses = pod.status?.containerStatuses ?? [];
  const waiting = containerStatuses.find((c) => c.state?.waiting);
  const terminated = containerStatuses.find((c) => c.state?.terminated);
  const ready = containerStatuses.every((c) => c.ready);
  const restartCount = containerStatuses.reduce(
    (s, c) => s + (c.restartCount ?? 0),
    0,
  );
  const startedAt = pod.status?.startTime
    ? new Date(pod.status.startTime).getTime()
    : undefined;
  const pendingSinceMs =
    pod.status?.phase === 'Pending' && startedAt
      ? Date.now() - startedAt
      : undefined;

  return {
    name: pod.metadata?.name ?? '',
    phase: pod.status?.phase,
    ready,
    waitingReason: waiting?.state?.waiting?.reason,
    terminatedReason: terminated?.state?.terminated?.reason,
    restartCount,
    pendingSinceMs,
  };
}

export function buildAppDto(
  workload: WorkloadDescriptor,
  pods: k8s.V1Pod[],
  serverIds: string[],
): TopologyAppDto {
  const podSummaries = pods.map(summarizePod);
  const placements: PodPlacement[] = pods
    .filter((p) => p.spec?.nodeName)
    .map((p) => ({
      podName: p.metadata?.name ?? '',
      serverId: p.spec?.nodeName,
      ordinal: statefulSetOrdinal(p.metadata?.name ?? ''),
    }));

  const counts = new Map<string, number>();
  for (const pl of placements) {
    counts.set(pl.serverId, (counts.get(pl.serverId) ?? 0) + 1);
  }
  const replicas: TopologyAppReplicaDto[] = [...counts.entries()].map(
    ([serverId, count]) => ({ serverId, count }),
  );
  const replicaCount = replicas.reduce((s, r) => s + r.count, 0);

  const status = deriveAppStatus({
    desiredReplicas: workload.desiredReplicas,
    pods: podSummaries,
    hpaEnabled: workload.hpaEnabled,
  });

  let primary =
    resolvePrimaryServerId(placements, workload.scalingMode, serverIds) ??
    serverIds[0] ??
    '';

  // For DaemonSets, prefer the lexicographically first server hosting a pod
  if (
    workload.scalingMode === TopologyScalingMode.DAEMONSET &&
    replicas.length > 0
  ) {
    primary = [...replicas].sort((a, b) =>
      a.serverId < b.serverId ? -1 : 1,
    )[0].serverId;
  }

  const kind: TopologyAppKind = resolveTopologyKind(
    workload.name,
    workload.declaredKind,
  );
  const category: TopologyAppCategory = resolveTopologyCategory(
    workload.name,
    kind,
    workload.declaredCategory,
  );

  let scalingNote = workload.scalingNote;
  if (!scalingNote) {
    if (workload.scalingMode === TopologyScalingMode.HPA) {
      scalingNote = `HPA · ${replicaCount} replicas`;
    } else if (workload.scalingMode === TopologyScalingMode.DAEMONSET) {
      scalingNote = 'DaemonSet · 1 per node';
    } else if (workload.scalingMode === TopologyScalingMode.STATEFULSET) {
      if (replicaCount === 2) scalingNote = 'primary+standby';
      else if (replicaCount > 0)
        scalingNote = `StatefulSet · ${replicaCount} replicas`;
    }
  }

  return {
    id: workload.appId,
    name: workload.name,
    slug: makeTopologySlug(workload.name),
    displayName: workload.displayName,
    category,
    kind,
    namespace: workload.namespace,
    status: status.status,
    statusReason: status.reason,
    ramRequestMB: workload.ramRequestMB,
    ramLimitMB: workload.ramLimitMB,
    cpuRequestM: workload.cpuRequestM,
    cpuLimitM: workload.cpuLimitM,
    primaryServerId: primary,
    replicas,
    replicaCount,
    scalingMode: workload.scalingMode,
    scalingNote,
    labels: workload.labels,
  };
}

export function deriveClusterStatus(
  servers: TopologyServerDto[],
  apps: TopologyAppDto[],
): TopologyHealthStatus {
  if (servers.length === 0) return TopologyHealthStatus.DOWN;
  if (servers.some((s) => s.status === TopologyHealthStatus.DOWN)) {
    return TopologyHealthStatus.DEGRADED;
  }
  if (apps.some((a) => a.status === TopologyAppStatus.ERROR)) {
    return TopologyHealthStatus.DEGRADED;
  }
  return TopologyHealthStatus.HEALTHY;
}

export function buildClusterDto(
  ctx: ClusterContext,
  servers: TopologyServerDto[],
  apps: TopologyAppDto[],
): TopologyClusterDto {
  return {
    id: ctx.id,
    name: ctx.name,
    displayName: ctx.displayName,
    provider: ctx.provider,
    region: ctx.region,
    status: deriveClusterStatus(servers, apps),
    servers,
    apps,
  };
}
