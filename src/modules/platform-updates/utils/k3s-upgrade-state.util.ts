import {
  K3sClusterUpgradeState,
  K3sNodeUpgradeState,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { PlatformReleaseEntry } from '../interfaces/release-manifest.interface';
import {
  K3sJobView,
  K3sNodeView,
  K3sUpgradePlan,
} from '../interfaces/k3s-upgrade.interface';
import {
  K3sVersion,
  compareK3sVersions,
  k3sUpgradePath,
  parseK3sVersion,
} from './k3s-path.util';
import { AGENT_PLAN, SERVER_PLAN, jobVersionLabel } from './k3s-plans.util';

export interface K3sClusterReading {
  nodes: K3sNodeView[];
  controller: { installed: boolean; ready: boolean };
  /** Why the cluster's API could not be read, when it could not. */
  readError?: string;
}

/** The oldest K3s version any node reports, as the node reports it. */
export function oldestK3sVersion(nodes: K3sNodeView[]): string | null {
  let oldest: { raw: string; parsed: K3sVersion } | null = null;
  for (const n of nodes) {
    const parsed = parseK3sVersion(n.kubeletVersion);
    if (!parsed || !n.kubeletVersion) continue;
    if (!oldest || compareK3sVersions(parsed, oldest.parsed) < 0) {
      oldest = { raw: n.kubeletVersion, parsed };
    }
  }
  return oldest?.raw ?? null;
}

export function allNodesAt(nodes: K3sNodeView[], step: string): boolean {
  const target = parseK3sVersion(step) as K3sVersion;
  return nodes.every((n) => {
    const running = parseK3sVersion(n.kubeletVersion);
    return running !== null && compareK3sVersions(running, target) >= 0;
  });
}

function readinessBlockers({ nodes, controller }: K3sClusterReading): string[] {
  const blockers = nodes
    .filter((n) => !n.ready)
    .map(
      (n) => `Node ${n.name} is not Ready; it would never finish an upgrade.`,
    );
  if (nodes.length > 0 && !controller.installed) {
    blockers.push(
      `The system-upgrade-controller is not installed on this cluster. Refresh its manifests first (it ships as common/02-system-upgrade-controller).`,
    );
  } else if (nodes.length > 0 && !controller.ready) {
    blockers.push('The system-upgrade-controller is not running.');
  }
  return blockers;
}

/** What upgrading one cluster to the target would do, and what stops it. */
export function assessK3sCluster(
  reading: K3sClusterReading,
  targetVersion: string,
  releases: PlatformReleaseEntry[],
): Omit<
  K3sUpgradePlan,
  | 'clusterId'
  | 'clusterName'
  | 'clusterType'
  | 'recordedVersion'
  | 'targetVersion'
> {
  const { nodes, controller } = reading;
  const blockers: string[] = [];
  if (reading.readError) {
    blockers.push(`The cluster's API could not be read: ${reading.readError}`);
  }
  const observed = oldestK3sVersion(nodes);
  for (const n of nodes.filter((n) => !parseK3sVersion(n.kubeletVersion))) {
    blockers.push(
      `Node ${n.name} reports K3s "${n.kubeletVersion ?? ''}", which cannot be read.`,
    );
  }
  let steps: string[] = [];
  if (nodes.length === 0 && blockers.length === 0) {
    blockers.push('The cluster reports no nodes.');
  }
  if (observed) {
    const path = k3sUpgradePath(observed, targetVersion, releases);
    steps = path.steps;
    if (path.blocker) blockers.push(path.blocker);
  }
  const upToDate =
    nodes.length > 0 && steps.length === 0 && blockers.length === 0;
  if (!upToDate) blockers.push(...readinessBlockers(reading));
  return {
    observedVersion: observed,
    steps,
    nodes: nodes.map((n) => ({
      name: n.name,
      role: n.server ? 'server' : 'agent',
      kubeletVersion: n.kubeletVersion,
      ready: n.ready,
    })),
    controller,
    upToDate,
    blockers,
  };
}

/** The state an upgrade of one cluster starts from, before any step. */
export function initialK3sState(
  plan: K3sUpgradePlan,
  clusterId: string,
  targetVersion: string,
  updatedAt: string,
): K3sClusterUpgradeState {
  return {
    clusterId,
    targetVersion,
    steps: plan.steps,
    stepIndex: 0,
    status: 'running',
    nodes: plan.nodes.map((n) => ({
      name: n.name,
      role: n.role,
      fromVersion: n.kubeletVersion,
      version: n.kubeletVersion,
      status: 'pending',
    })),
    updatedAt,
  };
}

/** Each node's progress toward a step, read from its kubelet and its upgrade Job. */
export function nodeStates(
  previous: K3sNodeUpgradeState[],
  tick: { nodes: K3sNodeView[]; jobs: K3sJobView[] },
  step: string,
): K3sNodeUpgradeState[] {
  const target = parseK3sVersion(step) as K3sVersion;
  const label = jobVersionLabel(step);
  return tick.nodes.map((node) => {
    const before = previous.find((p) => p.name === node.name);
    const base: K3sNodeUpgradeState = {
      name: node.name,
      role: node.server ? 'server' : 'agent',
      fromVersion: before?.fromVersion ?? node.kubeletVersion,
      version: node.kubeletVersion,
      status: 'pending',
    };
    const running = parseK3sVersion(node.kubeletVersion);
    if (running && compareK3sVersions(running, target) >= 0) {
      return { ...base, status: 'done' };
    }
    const job = tick.jobs
      .filter(
        (j) =>
          j.node === node.name &&
          (j.plan === SERVER_PLAN || j.plan === AGENT_PLAN) &&
          (j.version === null || j.version === label),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    if (!job) return base;
    if (job.failed) {
      return {
        ...base,
        status: 'failed',
        job: job.name,
        message: job.message,
      };
    }
    return {
      ...base,
      status: job.active ? 'upgrading' : 'pending',
      job: job.name,
    };
  });
}
