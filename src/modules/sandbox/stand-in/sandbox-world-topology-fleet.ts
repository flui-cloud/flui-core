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
  | 'example-cluster-3';

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
    name: 'staging',
    provider: 'scaleway',
    region: 'fr-par',
    regionName: 'Paris, France',
    type: 'workload',
    overlay: 'tunnel',
  },
  {
    id: 'example-cluster-3',
    privateNetwork: true,
    name: 'flui-control',
    provider: 'hetzner',
    region: 'nbg1',
    regionName: 'Nuremberg, Germany',
    type: 'control',
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
export const FLUI_NETWORK_EXCEPTIONS: Record<string, 'pending' | 'stale'> = {};

const MAIN_LOAD: Record<string, { usedMem: number; usedCpu: number }> = {
  'production-1': { usedMem: 0.383, usedCpu: 0.112 },
  'production-2': { usedMem: 0.527, usedCpu: 0.236 },
  'production-3': { usedMem: 0.614, usedCpu: 0.187 },
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
    'example-server-21',
    'example-cluster-2',
    'staging-1',
    'master',
    'DEV1-L',
    [4, 8192],
    [0.346, 0.063],
  ),
  server(
    'example-server-31',
    'example-cluster-3',
    'flui-control-1',
    'master',
    'cx33',
    [4, 8192],
    [0.571, 0.168],
  ),
];

/** The provider's id of each machine, as the instances list spells it. */
export function exampleProviderId(serverId: string): string {
  return `example-${WORLD_SERVERS.findIndex((s) => s.id === serverId) + 1}`;
}
