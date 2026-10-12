import { CliAppService } from './services/cli-app.service';
import { listClusters } from './cluster-listing';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const GONE = new Set(['deleted', 'deleting']);

/**
 * Resolve an application reference (name/slug or id) to its id. A UUID is used
 * as-is; a name/slug is looked up on `sourceClusterId` (app listing is
 * cluster-scoped, so the source cluster must be known first).
 */
export async function resolveApp(
  sourceClusterId: string,
  nameOrId: string,
): Promise<{ id: string; name: string }> {
  if (UUID_RE.test(nameOrId)) return { id: nameOrId, name: nameOrId };
  const svc = await CliAppService.create(sourceClusterId);
  const app = await svc.getAppByName(nameOrId);
  return { id: app.id, name: app.name };
}

/**
 * Like {@link resolveApp}, but without a known cluster it looks the name up on
 * every live cluster, workload clusters included, and refuses an ambiguous one.
 */
export async function resolveAppOnAnyCluster(
  nameOrId: string,
  sourceClusterId?: string,
): Promise<{ id: string; name: string }> {
  if (UUID_RE.test(nameOrId) || sourceClusterId) {
    return resolveApp(sourceClusterId as string, nameOrId);
  }
  const { clusters } = await listClusters();
  const found: Array<{ id: string; name: string; cluster: string }> = [];
  for (const cluster of clusters) {
    if (GONE.has(String((cluster as { status?: string }).status ?? ''))) {
      continue;
    }
    try {
      const app = await resolveApp(cluster.id, nameOrId);
      found.push({ ...app, cluster: cluster.name });
    } catch {
      continue;
    }
  }
  if (found.length === 1) return { id: found[0].id, name: found[0].name };
  if (found.length === 0) {
    throw new Error(`Application "${nameOrId}" not found on any cluster.`);
  }
  throw new Error(
    `Application "${nameOrId}" exists on several clusters (${found
      .map((f) => f.cluster)
      .join(', ')}). Pass --from <cluster>.`,
  );
}
