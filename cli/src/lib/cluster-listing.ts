import { CliClusterRepository } from './repositories/cli-cluster.repository';
import { ConfigStorage } from './config-storage';
import { ApiClient } from './api-client';

export interface ClusterNodeSummary {
  serverName?: string;
  nodeType?: string;
  ipAddress?: string;
  status?: string;
}

export interface ClusterSummary {
  id: string;
  name: string;
  provider?: string;
  region?: string;
  nodeSize?: string;
  nodeCount?: number;
  status?: string;
  clusterType?: string;
  k3sVersion?: string;
  masterIpAddress?: string;
  // Absent from the API's cluster DTO, so an API-sourced BYOS *workload* has no
  // host/port/user override. Correct for provisioned providers; revisit if BYOS
  // workloads ever need addressing over a published port.
  metadata?: unknown;
  nodes?: ClusterNodeSummary[];
}

export interface ClusterListing {
  clusters: ClusterSummary[];
  /** Set when the API could not be listed; `clusters` is then local-only. */
  apiError?: string;
}

/**
 * Local store first: it holds the clusters this CLI created (the control
 * cluster), so callers keep working without a login or a reachable API.
 * Dashboard-created workload clusters only exist in the control cluster's
 * database, so anything not found locally is looked up over the API.
 */
export async function listClusters(): Promise<ClusterListing> {
  const local = (await new CliClusterRepository().find()) as ClusterSummary[];

  try {
    const storage = new ConfigStorage();
    const apiUrl = storage.getApiUrlOrThrow();
    const apiKey = storage.getApiKey();
    if (!apiKey) {
      return { clusters: local, apiError: 'not logged in (`flui auth login`)' };
    }
    const remote = await new ApiClient({ baseUrl: apiUrl, apiKey }).get<
      ClusterSummary[]
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
