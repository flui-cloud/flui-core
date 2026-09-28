import { K3sPlan } from '../utils/k3s-plans.util';

export interface K3sNodeView {
  name: string;
  server: boolean;
  kubeletVersion: string | null;
  ready: boolean;
}

export interface K3sJobView {
  name: string;
  plan: string;
  node: string;
  version: string | null;
  active: boolean;
  failed: boolean;
  message?: string;
  createdAt: string;
}

/** What the upgrade reads and writes on a cluster. Every call may throw while the API server restarts. */
export interface K3sClusterPort {
  nodes(): Promise<K3sNodeView[]>;
  jobs(): Promise<K3sJobView[]>;
  controller(): Promise<{ installed: boolean; ready: boolean }>;
  applyPlans(plans: K3sPlan[]): Promise<void>;
  deletePlans(): Promise<void>;
}

export interface K3sUpgradePlan {
  clusterId: string;
  clusterName: string;
  clusterType: 'control' | 'workload';
  recordedVersion: string | null;
  /** The oldest K3s any node runs: where the path starts. */
  observedVersion: string | null;
  targetVersion: string;
  steps: string[];
  nodes: Array<{
    name: string;
    role: 'server' | 'agent';
    kubeletVersion: string | null;
    ready: boolean;
  }>;
  controller: { installed: boolean; ready: boolean };
  upToDate: boolean;
  blockers: string[];
}
