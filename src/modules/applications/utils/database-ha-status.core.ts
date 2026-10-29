import { ApplicationResourceStatus } from '../enums/application-resource-status.enum';
import { DatabaseHaSpec } from '../../postgres-ha/postgres-ha.types';

/**
 * A database made highly available keeps its single instance at zero copies
 * as the way back. Read as a workload that wants one copy and has none, it
 * made a serving database look broken; the instances that do serve are the
 * highly available cluster's.
 */
export function servesFromHaCluster(
  spec: DatabaseHaSpec | null | undefined,
  kind: string,
  actual: { spec?: { replicas?: number } },
): boolean {
  return (
    spec?.state === 'active' &&
    kind === 'StatefulSet' &&
    actual.spec?.replicas === 0
  );
}

/** Ready with every instance up; degraded while one is missing or a failover runs. */
export function haClusterStatus(
  cluster: {
    spec?: { instances?: number };
    status?: {
      phase?: string;
      readyInstances?: number;
      currentPrimary?: string;
    };
  } | null,
): ApplicationResourceStatus {
  if (!cluster?.status?.currentPrimary)
    return ApplicationResourceStatus.DEGRADED;
  const instances = cluster.spec?.instances ?? 0;
  const ready = cluster.status.readyInstances ?? 0;
  return cluster.status.phase === 'Cluster in healthy state' &&
    ready >= instances
    ? ApplicationResourceStatus.READY
    : ApplicationResourceStatus.DEGRADED;
}
