/** What a policy protects, named so a person can tell without looking up an id. */
export interface PolicyTargets {
  cluster: { id: string; name: string | null; gone: boolean } | null;
  /** Empty when the policy covers a whole cluster or namespace rather than named applications. */
  applications: Array<{
    id: string;
    name: string | null;
    slug: string | null;
    /** The application's page, or null when it no longer exists. */
    path: string | null;
    gone: boolean;
    /** `cluster` when it went with its cluster, whatever its own record says. */
    goneWith?: 'cluster';
  }>;
}

interface TargetCluster {
  id: string;
  name: string;
  status: string;
  deletedAt?: Date | null;
}

interface TargetApp {
  id: string;
  name: string;
  slug: string;
  status: string;
  deletedAt?: Date | null;
}

const GONE = new Set(['deleted', 'deleting']);

export function policyTargets(
  policy: {
    clusterId?: string | null;
    scopeSelector?: { applicationIds?: string[] } | null;
  },
  cluster: TargetCluster | null,
  apps: TargetApp[],
): PolicyTargets {
  const byId = new Map(apps.map((a) => [a.id, a]));
  const clusterGone =
    !!policy.clusterId &&
    (!cluster ||
      !!cluster.deletedAt ||
      GONE.has(String(cluster.status).toLowerCase()));
  return {
    cluster: policy.clusterId
      ? { id: policy.clusterId, name: cluster?.name ?? null, gone: clusterGone }
      : null,
    applications: (policy.scopeSelector?.applicationIds ?? []).map((id) => {
      const app = byId.get(id);
      const ownGone =
        !app || !!app.deletedAt || GONE.has(String(app.status).toLowerCase());
      const gone = ownGone || clusterGone;
      return {
        id,
        name: app?.name ?? null,
        slug: app?.slug ?? null,
        path: gone ? null : `/apps/applications/${id}`,
        gone,
        ...(!ownGone && clusterGone ? { goneWith: 'cluster' as const } : {}),
      };
    }),
  };
}
