import { DatabaseHaSpec } from '../../postgres-ha/postgres-ha.types';
import { ResourcePair } from '../../shared/utils/resource-quantity.util';

/** CloudNativePG restarts a cluster's instances one at a time when this annotation changes. */
export const CNPG_RESTART_ANNOTATION = 'kubectl.kubernetes.io/restartedAt';

const MOVING =
  'This database is being made highly available; wait until the move ends.';

/**
 * Why a change of copies, a stop or a start is refused: a highly available
 * database keeps its instances across three locations, and its single instance
 * stays at zero as the way back. Scaling that one would start a second
 * Postgres beside the cluster that serves.
 */
export function databaseHaReplicasRefusal(
  spec: DatabaseHaSpec | null | undefined,
): string | null {
  if (spec?.state === 'active') {
    return `This database is highly available: Flui keeps its ${spec.instances} instances across three locations, so the number of copies is not changed here, and it is not stopped or started.`;
  }
  return spec?.state === 'copying' ? MOVING : null;
}

/** While the copy is made the single instance still serves, and the cluster is being built from it. */
export function databaseHaResizeRefusal(
  spec: DatabaseHaSpec | null | undefined,
): string | null {
  return spec?.state === 'copying' ? MOVING : null;
}

/** The resources after a change: the values given over the current ones. */
export function mergedResources(
  current: ResourcePair,
  change: ResourcePair,
): ResourcePair {
  const side = (
    base?: { cpu?: string; memory?: string },
    next?: { cpu?: string; memory?: string },
  ) =>
    next
      ? {
          ...base,
          ...(next.cpu !== undefined && { cpu: next.cpu }),
          ...(next.memory !== undefined && { memory: next.memory }),
        }
      : base;
  const requests = side(current.requests, change.requests);
  const limits = side(current.limits, change.limits);
  return {
    ...(requests && { requests }),
    ...(limits && { limits }),
  };
}
