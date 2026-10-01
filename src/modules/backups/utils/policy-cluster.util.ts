import { ClusterStatus } from '../../infrastructure/clusters/entities/cluster.entity';

/** Neither protected nor unprotected: a deleted or lost cluster. */
export const GONE_CLUSTER_STATUSES = [
  ClusterStatus.DELETED,
  ClusterStatus.LOST,
];

export type PolicyClusterVerdict = 'run' | 'retire' | 'skip';

/**
 * What a due policy does about its cluster. A deleted (or vanished) cluster
 * will never come back, so its policy retires. A lost one may be rebuilt under
 * the same id, so the run is only skipped and the policy stays active, which
 * reads as missed: a lost cluster that is not being backed up is worth an alarm.
 */
export function policyClusterVerdict(
  cluster: { status: ClusterStatus; deletedAt?: Date | null } | null,
): PolicyClusterVerdict {
  if (!cluster) return 'retire';
  if (cluster.status === ClusterStatus.DELETED || cluster.deletedAt) {
    return 'retire';
  }
  if (cluster.status === ClusterStatus.LOST) return 'skip';
  return 'run';
}

export const CLUSTER_GONE_REASON = 'cluster_gone';

/** A policy retired because its cluster no longer exists. */
export function retiredForGoneCluster(policy: {
  metadata?: Record<string, unknown> | null;
}): boolean {
  return policy.metadata?.pausedReason === CLUSTER_GONE_REASON;
}
