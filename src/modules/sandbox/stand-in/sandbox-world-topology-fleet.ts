/** The example fleet's clusters and servers, as Topology draws them. */
import {
  CLUSTER_ID,
  CLUSTER_NAME,
  MACHINES,
  REGION,
} from './sandbox-world-core';

export type WorldClusterId =
  | typeof CLUSTER_ID
  | 'example-cluster-2'
  | 'example-cluster-3'
  | 'example-cluster-4'
  | 'example-cluster-5';

export interface WorldCluster {
  id: WorldClusterId;
  /** Whether the provider gives the cluster a private network between its servers. */
  privateNetwork: boolean;
  name: string;
  provider: string;
  region: string;
  regionName: string;
  type: 'control' | 'workload';
  overlay: 'tunnel' | 'public-address';
}

export const WORLD_CLUSTERS: WorldCluster[] = [
  {
    id: CLUSTER_ID,
    privateNetwork: true,
    name: CLUSTER_NAME,
    provider: 'hetzner',
    region: REGION,
    regionName: 'Falkenstein, Germany',
    type: 'workload',
    overlay: 'tunnel',
  },
  {
    id: 'example-cluster-2',
    privateNetwork: true,
    name: 'northwind-us',
    provider: 'hetzner',
    region: 'ash',
    regionName: 'Ashburn, United States',
    type: 'workload',
    overlay: 'tunnel',
  },
  {
    id: 'example-cluster-3',
    privateNetwork: true,
    name: 'northwind-asia',
    provider: 'ovh',
    region: 'SGP',
    regionName: 'Singapore',
    type: 'workload',
    overlay: 'public-address',
  },
  {
    id: 'example-cluster-4',
    privateNetwork: true,
    name: 'flui-control',
    provider: 'hetzner',
    region: REGION,
    regionName: 'Falkenstein, Germany',
    type: 'control',
    overlay: 'tunnel',
  },
  {
    id: 'example-cluster-5',
    privateNetwork: true,
    name: 'northwind-staging',
    provider: 'scaleway',
    region: 'fr-par',
    regionName: 'Paris, France',
    type: 'workload',
    overlay: 'tunnel',
  },
];

export interface WorldServer {
  id: string;
  clusterId: WorldClusterId;
  name: string;
  role: 'master' | 'worker';
  serverType: string;
  architecture: 'x86' | 'arm';
  cpuCores: number;
  ramMb: number;
  /** Share actually in use, before the slow drift the stream adds. */
  used: { mem: number; cpu: number };
}

/** Where a server stands on the Flui network, when it is not simply connected. */
export const FLUI_NETWORK_EXCEPTIONS: Record<string, 'pending' | 'stale'> = {
  'us-worker-4': 'pending',
  'asia-node-1': 'stale',
  'asia-node-2': 'stale',
  'asia-node-3': 'stale',
};

const MAIN_LOAD: Record<string, { usedMem: number; usedCpu: number }> = {
  'flui-edge-1': { usedMem: 0.48, usedCpu: 0.22 },
  'flui-worker-1': { usedMem: 0.72, usedCpu: 0.41 },
  'flui-worker-2': { usedMem: 0.92, usedCpu: 0.58 },
  'flui-worker-4': { usedMem: 0.81, usedCpu: 0.47 },
  'flui-arm-1': { usedMem: 0.64, usedCpu: 0.3 },
  'flui-arm-2': { usedMem: 0.57, usedCpu: 0.26 },
};

const server = (
  id: string,
  clusterId: WorldClusterId,
  name: string,
  role: WorldServer['role'],
  serverType: string,
  size: [cores: number, ramMb: number, arch?: 'arm'],
  load: [usedMem: number, usedCpu: number],
): WorldServer => ({
  id,
  clusterId,
  name,
  role,
  serverType,
  architecture: size[2] ?? 'x86',
  cpuCores: size[0],
  ramMb: size[1],
  used: { mem: load[0], cpu: load[1] },
});

export const WORLD_SERVERS: WorldServer[] = [
  ...MACHINES.map((m) => {
    const load = MAIN_LOAD[m.name];
    return {
      id: m.id,
      clusterId: CLUSTER_ID as WorldClusterId,
      name: m.name,
      role: m.role,
      serverType: m.productName.toLowerCase(),
      architecture: m.architecture,
      cpuCores: m.cpuCores,
      ramMb: m.ramMb,
      used: { mem: load.usedMem, cpu: load.usedCpu },
    };
  }),
  server(
    'example-server-11',
    'example-cluster-2',
    'us-master-1',
    'master',
    'cpx31',
    [4, 8192],
    [0.41, 0.18],
  ),
  server(
    'example-server-12',
    'example-cluster-2',
    'us-worker-1',
    'worker',
    'cpx41',
    [8, 16_384],
    [0.63, 0.35],
  ),
  server(
    'example-server-13',
    'example-cluster-2',
    'us-worker-2',
    'worker',
    'cpx41',
    [8, 16_384],
    [0.58, 0.31],
  ),
  server(
    'example-server-14',
    'example-cluster-2',
    'us-worker-3',
    'worker',
    'cpx41',
    [8, 16_384],
    [0.52, 0.29],
  ),
  server(
    'example-server-15',
    'example-cluster-2',
    'us-worker-4',
    'worker',
    'cpx31',
    [4, 8192],
    [0.36, 0.14],
  ),
  server(
    'example-server-21',
    'example-cluster-3',
    'asia-node-1',
    'master',
    'b3-16',
    [4, 16_000],
    [0.69, 0.4],
  ),
  server(
    'example-server-22',
    'example-cluster-3',
    'asia-node-2',
    'worker',
    'b3-16',
    [4, 16_000],
    [0.74, 0.44],
  ),
  server(
    'example-server-23',
    'example-cluster-3',
    'asia-node-3',
    'worker',
    'b3-32',
    [8, 32_000],
    [0.55, 0.27],
  ),
  server(
    'example-server-31',
    'example-cluster-4',
    'control-master-1',
    'master',
    'cpx31',
    [4, 8192],
    [0.66, 0.25],
  ),
  server(
    'example-server-32',
    'example-cluster-4',
    'control-worker-1',
    'worker',
    'cpx41',
    [8, 16_384],
    [0.44, 0.18],
  ),
  server(
    'example-server-41',
    'example-cluster-5',
    'staging-1',
    'master',
    'DEV1-L',
    [4, 8192],
    [0.35, 0.09],
  ),
  server(
    'example-server-42',
    'example-cluster-5',
    'staging-2',
    'worker',
    'DEV1-L',
    [4, 8192],
    [0.38, 0.11],
  ),
];

/** The provider's id of each machine, as the instances list spells it. */
export function exampleProviderId(serverId: string): string {
  return `example-${WORLD_SERVERS.findIndex((s) => s.id === serverId) + 1}`;
}
