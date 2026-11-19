import { ClusterEntity, ClusterStatus } from '../entities/cluster.entity';

export const DESTROYED_STATUSES = [
  ClusterStatus.DELETING,
  ClusterStatus.DELETION_FAILED,
  ClusterStatus.DELETED,
];

/** A cluster someone asked to destroy: nothing should try to reach it any more. */
export function beingDestroyed(
  cluster: Pick<ClusterEntity, 'status' | 'deletedAt'>,
): boolean {
  return !!cluster.deletedAt || DESTROYED_STATUSES.includes(cluster.status);
}
