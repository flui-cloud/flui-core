import { POOLER_OF_LABEL } from './db-pooler.core';

export const POOLER_SWEEP_KINDS = [
  'Deployment',
  'Service',
  'EndpointSlice',
  'Secret',
  'NetworkPolicy',
] as const;

export interface PoolerSweepResult {
  deleted: string[];
  failed: Array<{ object: string; error: string }>;
}

/**
 * Remove every object of a database's pooler, found by `flui.cloud/pooler-of`.
 *
 * Read off the cluster rather than the row: the pooler objects are never in the
 * application's tracked resources, and a teardown must also catch what was
 * rendered from a spec that is no longer on the row.
 */
export async function sweepPoolerObjects(
  kubernetes: {
    listResourcesByLabel(
      kubeconfig: string,
      kind: string,
      namespace: string,
      labelSelector: string,
    ): Promise<any[]>;
    deleteResource(
      kubeconfig: string,
      kind: string,
      name: string,
      namespace: string,
    ): Promise<void>;
  },
  kubeconfig: string,
  namespace: string,
  appId: string,
): Promise<PoolerSweepResult> {
  const result: PoolerSweepResult = { deleted: [], failed: [] };
  const selector = `${POOLER_OF_LABEL}=${appId}`;
  for (const kind of POOLER_SWEEP_KINDS) {
    const items = await kubernetes
      .listResourcesByLabel(kubeconfig, kind, namespace, selector)
      .catch(() => [] as any[]);
    for (const item of items) {
      const name = item?.metadata?.name as string | undefined;
      if (!name) continue;
      try {
        await kubernetes.deleteResource(kubeconfig, kind, name, namespace);
        result.deleted.push(`${kind}/${name}`);
      } catch (err) {
        result.failed.push({
          object: `${kind}/${name}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return result;
}
