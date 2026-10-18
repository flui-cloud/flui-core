import * as k8s from '@kubernetes/client-node';
import { createHash } from 'node:crypto';
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
  TopologyArchitecture,
  TopologyExposure,
  TopologyFluiNetwork,
  TopologyHealthStatus,
  TopologyScalingMode,
  TopologyServerRole,
  TopologyWorkloadKind,
} from '../enums/topology.enums';
import {
  TopologyAppDto,
  TopologyAppReplicaDto,
  TopologyServerDto,
} from '../dto/topology.dto';
import { makeTopologySlug } from '../utils/slug.util';
import {
  resolveTopologyCategory,
  resolveTopologyKind,
} from '../utils/category.util';

export const FLUI_MANAGED_LABEL_SELECTOR =
  'app.kubernetes.io/managed-by=flui-cloud';

export interface ServerRecord {
  id: string;
  providerResourceId: string | null;
  serverType: string | null;
  isMaster: boolean;
  privateNetwork: boolean;
  fluiNetwork: TopologyFluiNetwork;
}

export interface ClusterContext {
  id: string;
  provider: string;
  /** The server records of this cluster, by node name. */
  records: Map<string, ServerRecord>;
}

/** A node Flui holds no record of keeps an id that does not carry its name. */
export function serverIdFor(
  clusterId: string,
  nodeName: string,
  record?: ServerRecord,
): string {
  if (record) return record.id;
  const digest = createHash('sha256').update(nodeName).digest('hex');
  return `node:${clusterId}:${digest.slice(0, 12)}`;
}

export function architectureOf(node: k8s.V1Node): TopologyArchitecture | null {
  const arch = node.status?.nodeInfo?.architecture ?? '';
  if (arch === 'amd64' || arch === '386') return TopologyArchitecture.X86;
  if (arch.startsWith('arm')) return TopologyArchitecture.ARM;
  return null;
}

export function takesWork(node: k8s.V1Node): boolean {
  if (node.spec?.unschedulable) return false;
  const ready = (node.status?.conditions ?? []).find((c) => c.type === 'Ready');
  if (ready?.status !== 'True') return false;
  return !(node.spec?.taints ?? []).some(
    (t) => t.effect === 'NoSchedule' || t.effect === 'NoExecute',
  );
}

export function mapNodesToServers(
  nodes: k8s.V1Node[],
  ctx: ClusterContext,
): TopologyServerDto[] {
  return nodes.map((n) => {
    const name = n.metadata?.name ?? '';
    const record = ctx.records.get(name);
    const labels = n.metadata?.labels ?? {};
    const isControlPlane =
      record?.isMaster ||
      'node-role.kubernetes.io/control-plane' in labels ||
      'node-role.kubernetes.io/master' in labels;
    return {
      id: serverIdFor(ctx.id, name, record),
      clusterId: ctx.id,
      nodeName: name,
      provider: ctx.provider,
      providerResourceId: record?.providerResourceId ?? null,
      serverType: record?.serverType ?? null,
      architecture: architectureOf(n),
      role: isControlPlane
        ? TopologyServerRole.CONTROL_PLANE
        : TopologyServerRole.WORKER,
      takesWork: takesWork(n),
      status: nodeReadyToHealth(n),
      capacity: null,
      podCount: 0,
      privateNetwork: record?.privateNetwork ?? false,
      fluiNetwork: record?.fluiNetwork ?? TopologyFluiNetwork.NONE,
    };
  });
}

function nodeReadyToHealth(node: k8s.V1Node): TopologyHealthStatus {
  const ready = node.status?.conditions?.find((c) => c.type === 'Ready');
  if (ready?.status === 'True') return TopologyHealthStatus.HEALTHY;
  if (ready?.status === 'False') return TopologyHealthStatus.DOWN;
  return TopologyHealthStatus.DEGRADED;
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
  workloadKind: TopologyWorkloadKind;
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
  /** Where its configuration lives: plain values and config maps, never secrets. */
  config: WorkloadConfig;
}

export interface WorkloadConfig {
  entries: { key: string; value: string }[];
  /** Config maps loaded whole (`envFrom`). */
  configMaps: string[];
  /** Single keys taken from a config map, under the variable name they become. */
  configMapKeys: { name: string; key: string; as: string }[];
}

/** What a pod template says about its configuration, secrets left out by construction. */
export function configOf(
  template: k8s.V1PodTemplateSpec | undefined,
): WorkloadConfig {
  const config: WorkloadConfig = {
    entries: [],
    configMaps: [],
    configMapKeys: [],
  };
  const spec = template?.spec;
  for (const c of [
    ...(spec?.initContainers ?? []),
    ...(spec?.containers ?? []),
  ]) {
    addContainerConfig(config, c);
  }
  return config;
}

function addContainerConfig(config: WorkloadConfig, c: k8s.V1Container): void {
  for (const e of c.env ?? []) {
    if (typeof e.value === 'string') {
      config.entries.push({ key: e.name, value: e.value });
    }
    const ref = e.valueFrom?.configMapKeyRef;
    if (ref?.name) {
      config.configMapKeys.push({ name: ref.name, key: ref.key, as: e.name });
    }
  }
  for (const from of c.envFrom ?? []) {
    if (from.configMapRef?.name) config.configMaps.push(from.configMapRef.name);
  }
  // A command can name a host too: an init container waiting on `nc -z postgres 5432`.
  const command = [...(c.command ?? []), ...(c.args ?? [])].join(' ');
  if (command) config.entries.push({ key: 'COMMAND', value: command });
}

export function describeDeployment(d: k8s.V1Deployment): WorkloadDescriptor {
  return describeWorkload({
    spec: d.spec ?? {},
    metadata: d.metadata,
    workloadKind: TopologyWorkloadKind.DEPLOYMENT,
    scalingMode: TopologyScalingMode.MANUAL,
    desiredReplicas: d.spec?.replicas ?? 0,
  });
}

export function describeStatefulSet(s: k8s.V1StatefulSet): WorkloadDescriptor {
  return describeWorkload({
    spec: s.spec ?? {},
    metadata: s.metadata,
    workloadKind: TopologyWorkloadKind.STATEFULSET,
    scalingMode: TopologyScalingMode.STATEFULSET,
    desiredReplicas: s.spec?.replicas ?? 0,
  });
}

export function describeDaemonSet(d: k8s.V1DaemonSet): WorkloadDescriptor {
  return describeWorkload({
    spec: d.spec ?? {},
    metadata: d.metadata,
    workloadKind: TopologyWorkloadKind.DAEMONSET,
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
  workloadKind: TopologyWorkloadKind;
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
    workloadKind: args.workloadKind,
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
    config: configOf(args.spec.template),
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
  servers: TopologyServerDto[],
  clusterId: string,
): TopologyAppDto {
  const podSummaries = pods.map(summarizePod);
  const serverIds = servers.map((s) => s.id);
  const serverIdByNode = new Map(servers.map((s) => [s.nodeName, s.id]));
  const placements: PodPlacement[] = pods
    .filter((p) => p.spec?.nodeName)
    .map((p) => ({
      podName: p.metadata?.name ?? '',
      serverId: serverIdByNode.get(p.spec!.nodeName!) ?? p.spec!.nodeName!,
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

  // Whatever runs in the platform's own namespaces is Flui's, whatever its name.
  const kind: TopologyAppKind = PLATFORM_NAMESPACES.has(workload.namespace)
    ? TopologyAppKind.SYSTEM
    : resolveTopologyKind(workload.name, workload.declaredKind);
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
    clusterId,
    stackId: `app:${workload.appId}`,
    groupKey: `app:${workload.appId}`,
    workloadKind: workload.workloadKind,
    exposure: TopologyExposure.CLUSTER,
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
    projectId: null,
  };
}

export function deriveClusterStatus(
  servers: Pick<TopologyServerDto, 'status'>[],
  apps: Pick<TopologyAppDto, 'status'>[],
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

const PLATFORM_NAMESPACES = new Set([
  'flui-system',
  'flui-control',
  'kube-system',
]);

export const LIST_PAGE_SIZE = 10;
const MAX_PAGES = 200;

/**
 * A list read a page at a time. One answer holding every object of a large
 * cluster is a body a slow link can cut short, and memory spent all at once.
 */
export async function listAll<T>(
  page: (next?: string) => Promise<{
    items?: T[];
    metadata?: { _continue?: string };
  }>,
): Promise<T[]> {
  const items: T[] = [];
  let next: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await page(next);
    items.push(...(res.items ?? []));
    next = res.metadata?._continue;
    if (!next) break;
  }
  return items;
}
