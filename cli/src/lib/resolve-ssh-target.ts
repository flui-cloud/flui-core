import { isControlClusterType } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { ClusterSummary, listClusters } from './cluster-listing';
import { CliClusterRepository } from './repositories/cli-cluster.repository';
import { resolveClusterSshTarget, SshTarget } from './cluster-ssh-target';
import { ManagementNetworkClient } from './management-network-client';

export const JUMP_USER = 'flui-jump';

export interface ResolvedSshTarget {
  target: SshTarget;
  clusterName: string;
  nodeLabel: string;
  /** Set when the node is reached through the control, on its Flui network address. */
  jump?: SshTarget;
}

/**
 * `<cluster>/<node>` addresses any cluster; a bare `<node>` keeps meaning the
 * control cluster, which is what every existing example and doc says.
 */
export function parseNodeRef(ref: string): {
  clusterName?: string;
  nodeName: string;
} {
  const slash = ref.indexOf('/');
  if (slash === -1) return { nodeName: ref };
  return {
    clusterName: ref.slice(0, slash),
    nodeName: ref.slice(slash + 1),
  };
}

function formatClusterList(clusters: ClusterSummary[]): string {
  return clusters
    .map((c) => {
      const nodes = (c.nodes ?? [])
        .map((n) => n.serverName)
        .filter(Boolean)
        .join(', ');
      const suffix = nodes ? `  (${nodes})` : '';
      return `  • ${c.name}${suffix}`;
    })
    .join('\n');
}

function resolveNodeIp(
  cluster: ClusterSummary,
  nodeName: string,
): { ip: string; label: string; serverName?: string } {
  const nodes = cluster.nodes ?? [];

  if (nodeName === 'master') {
    const master = nodes.find((n) => n.nodeType === 'master');
    const ip = cluster.masterIpAddress || master?.ipAddress;
    if (!ip) {
      throw new Error(
        `Master of "${cluster.name}" has no IP address yet — it may still be provisioning.`,
      );
    }
    return { ip, label: 'Master Node', serverName: master?.serverName };
  }

  const workerIndex = Number.parseInt(nodeName.replace('worker-', ''), 10);
  if (nodeName.startsWith('worker-') && !Number.isNaN(workerIndex)) {
    const worker = nodes.find(
      (n) =>
        n.nodeType === 'worker' &&
        (n.serverName ?? '').includes(`worker-${workerIndex}`),
    );
    if (!worker?.ipAddress) {
      throw new Error(
        `Node "worker-${workerIndex}" not found in "${cluster.name}".`,
      );
    }
    return {
      ip: worker.ipAddress,
      label: `Worker Node ${workerIndex}`,
      serverName: worker.serverName,
    };
  }

  const named = nodes.find((n) => n.serverName === nodeName);
  if (named?.ipAddress) {
    return {
      ip: named.ipAddress,
      label: nodeName,
      serverName: named.serverName,
    };
  }

  const available = nodes
    .map((n) => n.serverName)
    .filter(Boolean)
    .map((n) => `  • ${n}`)
    .join('\n');
  const suffix = available ? `:\n${available}` : '.';
  throw new Error(
    `Unknown node "${nodeName}" in "${cluster.name}". Use master, worker-N, ` +
      `or a server name${suffix}`,
  );
}

export async function resolveSshTarget(
  ref: string,
): Promise<ResolvedSshTarget> {
  const { clusterName, nodeName } = parseNodeRef(ref);

  // The control is on this machine's record, and its node is reached with a
  // certificate this CLI signs: nothing about it needs the API, which is the
  // way back in when the API is the thing that is down.
  const local = (await new CliClusterRepository().find()) as ClusterSummary[];
  const localControl = local.find(
    (c) =>
      isControlClusterType(c.clusterType) &&
      (!clusterName || c.name.toLowerCase() === clusterName.toLowerCase()),
  );
  if (localControl) {
    const { ip, label } = resolveNodeIp(localControl, nodeName);
    return {
      target: resolveClusterSshTarget(localControl, ip),
      clusterName: localControl.name,
      nodeLabel: label,
    };
  }

  const { clusters, apiError } = await listClusters();

  if (clusters.length === 0) {
    const why = apiError ? ` (API lookup failed: ${apiError})` : '';
    throw new Error(
      `No clusters found${why}. Create one with \`flui env create\`.`,
    );
  }

  // A bare node name keeps addressing the control cluster.
  const cluster = clusterName
    ? clusters.find((c) => c.name.toLowerCase() === clusterName.toLowerCase())
    : clusters.find((c) => isControlClusterType(c.clusterType));

  if (!cluster) {
    const missing = clusterName
      ? `Cluster "${clusterName}" not found.`
      : 'No control cluster found.';
    const degraded = apiError
      ? ` Workload clusters could not be listed: ${apiError}.`
      : '';
    throw new Error(
      `${missing}${degraded}\nAvailable:\n${formatClusterList(clusters)}` +
        '\n\nAddress a node as <cluster>/<node>, e.g. `flui ssh my-cluster/master`.',
    );
  }

  const { ip, label, serverName } = resolveNodeIp(cluster, nodeName);
  const target = resolveClusterSshTarget(cluster, ip);

  if (!isControlClusterType(cluster.clusterType)) {
    const control = clusters.find((c) => isControlClusterType(c.clusterType));
    const route = await throughControl(cluster, serverName, control);
    if (route) {
      return {
        target: { ...target, host: route.address, port: 22 },
        jump: route.jump,
        clusterName: cluster.name,
        nodeLabel: label,
      };
    }
  }

  return { target, clusterName: cluster.name, nodeLabel: label };
}

/**
 * A workload node on the Flui network is reached through the control, on its
 * network address: the control is the bastion, and a workload's port 22 never
 * needs to face the internet. Anything that cannot be read leaves the direct
 * route as it was.
 */
async function throughControl(
  cluster: ClusterSummary,
  serverName: string | undefined,
  control: ClusterSummary | undefined,
): Promise<{ address: string; jump: SshTarget } | null> {
  const controlHost = control?.masterIpAddress;
  if (!serverName || !controlHost) return null;
  try {
    const network = await ManagementNetworkClient.open().status();
    if (!network.enabled) return null;
    const member = network.members.find(
      (m) =>
        m.clusterId === cluster.id &&
        m.nodeName === serverName &&
        m.status === 'active',
    );
    if (!member) return null;
    const controlTarget = resolveClusterSshTarget(
      control as ClusterSummary,
      controlHost,
    );
    return {
      address: member.address,
      jump: { ...controlTarget, user: JUMP_USER },
    };
  } catch {
    return null;
  }
}
