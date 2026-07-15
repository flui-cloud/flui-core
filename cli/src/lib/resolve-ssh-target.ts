import { isControlClusterType } from 'src/modules/infrastructure/clusters/entities/cluster.entity';
import { CliClusterRepository } from './repositories/cli-cluster.repository';
import { ConfigStorage } from './config-storage';
import { ApiClient } from './api-client';
import { resolveClusterSshTarget, SshTarget } from './cluster-ssh-target';

interface SshCandidateNode {
  serverName?: string;
  nodeType?: string;
  ipAddress?: string;
}

interface SshCandidateCluster {
  id: string;
  name: string;
  provider?: string;
  clusterType?: string;
  // Absent from the API's cluster DTO, so a BYOS *workload* falls back to
  // <ip>:22 as root. Correct for provisioned providers; revisit if BYOS
  // workloads ever need addressing over a published port.
  metadata?: unknown;
  masterIpAddress?: string;
  nodes?: SshCandidateNode[];
}

export interface ResolvedSshTarget {
  target: SshTarget;
  clusterName: string;
  nodeLabel: string;
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

function formatClusterList(clusters: SshCandidateCluster[]): string {
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

/**
 * Local store first: it holds the clusters this CLI created (the control
 * cluster), so `flui ssh master` keeps working without a login or a reachable
 * API. Dashboard-created workload clusters only exist in the control cluster's
 * database, so anything not found locally is looked up over the API.
 */
async function listCandidateClusters(): Promise<{
  clusters: SshCandidateCluster[];
  apiError?: string;
}> {
  const local =
    (await new CliClusterRepository().find()) as SshCandidateCluster[];

  try {
    const storage = new ConfigStorage();
    const apiUrl = storage.getApiUrlOrThrow();
    const apiKey = storage.getApiKey();
    if (!apiKey) {
      return { clusters: local, apiError: 'not logged in (`flui auth login`)' };
    }
    const remote = await new ApiClient({ baseUrl: apiUrl, apiKey }).get<
      SshCandidateCluster[]
    >('/infrastructure/clusters');

    const byName = new Map(local.map((c) => [c.name.toLowerCase(), c]));
    for (const cluster of remote) {
      if (!byName.has(cluster.name.toLowerCase())) {
        byName.set(cluster.name.toLowerCase(), cluster);
      }
    }
    return { clusters: [...byName.values()] };
  } catch (error) {
    return {
      clusters: local,
      apiError: error instanceof Error ? error.message : String(error),
    };
  }
}

function resolveNodeIp(
  cluster: SshCandidateCluster,
  nodeName: string,
): { ip: string; label: string } {
  const nodes = cluster.nodes ?? [];

  if (nodeName === 'master') {
    const master = nodes.find((n) => n.nodeType === 'master');
    const ip = cluster.masterIpAddress || master?.ipAddress;
    if (!ip) {
      throw new Error(
        `Master of "${cluster.name}" has no IP address yet — it may still be provisioning.`,
      );
    }
    return { ip, label: 'Master Node' };
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
    return { ip: worker.ipAddress, label: `Worker Node ${workerIndex}` };
  }

  const named = nodes.find((n) => n.serverName === nodeName);
  if (named?.ipAddress) {
    return { ip: named.ipAddress, label: nodeName };
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
  const { clusters, apiError } = await listCandidateClusters();

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

  const { ip, label } = resolveNodeIp(cluster, nodeName);

  return {
    target: resolveClusterSshTarget(cluster, ip),
    clusterName: cluster.name,
    nodeLabel: label,
  };
}
