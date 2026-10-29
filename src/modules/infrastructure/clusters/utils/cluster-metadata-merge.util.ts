import { Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';

/**
 * Sets a few metadata keys in one statement. A sweep that saved the whole
 * entity would put back what it read, undoing keys another sweep wrote since.
 */
export async function mergeClusterMetadata(
  clusters: Repository<ClusterEntity>,
  clusterId: string,
  keys: Record<string, unknown>,
): Promise<void> {
  await clusters
    .createQueryBuilder()
    .update(ClusterEntity)
    .set({
      metadata: () =>
        `(COALESCE("metadata"::jsonb, '{}'::jsonb) || CAST(:keys AS jsonb))::json`,
    })
    .setParameter('keys', JSON.stringify(keys))
    .where('id = :id', { id: clusterId })
    .execute();
}
