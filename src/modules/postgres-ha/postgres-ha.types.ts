import { PostgresHaDurability } from './utils/cnpg-cluster.core';
import { CNPG_INSTANCE_ROLE_LABEL } from '../infrastructure/shared/utils/database-pod.util';

/**
 * A managed Postgres that has moved, or is moving, from its single instance to
 * a highly available cluster. Null on the application row is the single
 * instance every install has had so far.
 */
export interface DatabaseHaSpec {
  engine: 'cnpg';
  /** The highly available cluster's name, in the application's namespace. */
  cluster: string;
  durability: PostgresHaDurability;
  instances: number;
  /**
   * `copying`: the cluster streams from the single instance, which still serves.
   * `active`: the cluster serves; the single instance is kept at zero copies.
   * `failed`: the move stopped; the single instance serves again.
   */
  state: 'copying' | 'active' | 'failed';
  since: string;
  detail?: string;
  /** When Flui last moved the primary back to a location for data. */
  primaryMovedAt?: string;
}

/** Whether the application's traffic goes to the highly available cluster. */
export function databaseHaServes(
  spec: DatabaseHaSpec | null | undefined,
): spec is DatabaseHaSpec {
  return spec?.state === 'active';
}

export function databaseHaPrimarySelector(
  spec: DatabaseHaSpec,
): Record<string, string> {
  return {
    'cnpg.io/cluster': spec.cluster,
    [CNPG_INSTANCE_ROLE_LABEL]: 'primary',
  };
}
