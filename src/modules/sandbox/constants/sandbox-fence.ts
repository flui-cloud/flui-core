/**
 * What a sandbox guest may call. Everything absent from this list is refused —
 * the fence is an allowlist, not a list of holes to plug, because the surface it
 * guards is 588 routes of which 248 carry no authorization of their own.
 *
 * It is enforced on the route, never in the interface: hiding a button stops a
 * person, not an agent holding the guest's own credential. The same list is
 * served to the guest as "what is disabled here, and why".
 */

export type HttpVerb = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface SandboxAllowRule {
  verbs: HttpVerb[];
  /** Route pattern; `:param` matches one segment, `**` matches the rest. */
  pattern: string;
  why: string;
}

/**
 * Per-application routes are listed as `**` on purpose: each one already passes
 * AppAccessGuard or AppOwnershipGuard, so a guest reaching them can only reach
 * its own application. The fence removes whole areas; ownership does the rest.
 */
export const SANDBOX_ALLOWLIST: SandboxAllowRule[] = [
  {
    verbs: ['GET'],
    pattern: '/auth/me',
    why: 'Know who you are signed in as.',
  },
  {
    // `/me/...`, not `/iam/me/...`: MeController is mounted at the root even
    // though it lives in the IAM module, and the earlier pattern matched no
    // route at all — which refused a guest the two calls the sidebar and every
    // permission check in the interface depend on.
    verbs: ['GET'],
    pattern: '/me/**',
    why: 'Resolve which parts of the interface to show.',
  },
  { verbs: ['GET'], pattern: '/version', why: 'Show the platform version.' },
  { verbs: ['GET'], pattern: '/health/**', why: 'Liveness of the instance.' },

  {
    verbs: ['GET'],
    pattern: '/clusters/:clusterId/applications',
    why: 'List the applications you own.',
  },
  {
    verbs: ['POST'],
    pattern: '/clusters/:clusterId/applications',
    why: 'Create an application of your own.',
  },
  {
    verbs: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    pattern: '/applications/:id/**',
    why: 'Operate your own application — logs, metrics, deploys, its database console.',
  },
  {
    verbs: ['GET', 'PATCH'],
    pattern: '/applications/:id',
    why: 'Read and change your own application.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/applications/:id/logs',
    why: 'Read logs selected from an application you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/applications/:id/logs/volume',
    why: 'Chart log volume for an application you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/applications/:id/metrics',
    why: 'Read resource metrics for an application you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/applications/:id/metrics/history',
    why: 'Chart resource metrics for an application you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/applications/:id/traffic',
    why: 'Read traffic metrics for an application you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/applications/:id/traffic/history',
    why: 'Chart traffic metrics for an application you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/applications/:id/alerts',
    why: 'Read alerts for an application you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/clusters/:clusterId/applications/metrics',
    why: 'Read metrics filtered to applications you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/clusters/:clusterId/applications/metrics/history',
    why: 'Chart metrics filtered to applications you may access.',
  },
  {
    verbs: ['GET'],
    pattern: '/observability/clusters/:clusterId/traffic',
    why: 'Read traffic filtered to applications you may access.',
  },

  {
    verbs: ['GET'],
    pattern: '/catalog/**',
    why: 'Browse what you can install.',
  },
  { verbs: ['GET'], pattern: '/catalog', why: 'Browse what you can install.' },
  {
    verbs: ['POST'],
    pattern: '/catalog/:slug/install',
    why: 'Install a catalog application into your own tenancy.',
  },
  {
    verbs: ['GET'],
    pattern: '/catalog-installs/**',
    why: 'Follow an installation you started.',
  },

  {
    verbs: ['GET'],
    pattern: '/infrastructure/operations/:id',
    why: 'Follow the progress of something you started.',
  },
  {
    verbs: ['GET'],
    pattern: '/sandbox/**',
    why: 'Read your own tenancy: what is disabled, and how long you have left.',
  },
];

/**
 * Areas refused wholesale, with the reason a guest is shown. Ordered most-asked
 * first — this is the copy for the "what is disabled" page, not just telemetry.
 */
export const SANDBOX_DENIED_AREAS: Array<{ area: string; why: string }> = [
  {
    area: 'Infrastructure — clusters, servers, nodes, firewalls, providers',
    why: 'The instance is shared. Changing a node changes it for every guest on it.',
  },
  {
    area: 'DNS zones and custom domains',
    why: 'Your applications get a name under try.flui.cloud. Pointing a domain you own at a machine you share is a door we keep shut.',
  },
  {
    area: 'Access — users, roles, SSH keys, API keys',
    why: 'Access control is the wall around your tenancy. It is not something to explore from inside it.',
  },
  {
    area: 'Cluster-wide variables and secrets',
    why: "Those belong to the platform, not to a tenancy. Your application's own variables are yours to edit.",
  },
  {
    area: 'Backups, snapshots and restores',
    why: 'Everything here is deleted in 24 hours by design. A backup would outlive what it protects.',
  },
  {
    area: 'Gateway policies and cross-cluster migration',
    why: 'They act on shared infrastructure. Watch them in the showcase instead.',
  },
  {
    area: 'Mail',
    why: 'It shows real recipients — other people’s data.',
  },
];

const SEGMENTS = (path: string): string[] =>
  path.split('/').filter((s) => s.length > 0);

/** `:param` matches one segment, `**` matches the remainder (at least one). */
export function routeMatches(pattern: string, path: string): boolean {
  const p = SEGMENTS(pattern);
  const t = SEGMENTS(path);

  for (let i = 0; i < p.length; i++) {
    if (p[i] === '**') return t.length > i;
    if (i >= t.length) return false;
    if (p[i].startsWith(':')) continue;
    if (p[i] !== t[i]) return false;
  }
  return p.length === t.length;
}

export function isSandboxAllowed(verb: string, path: string): boolean {
  return SANDBOX_ALLOWLIST.some(
    (rule) =>
      rule.verbs.includes(verb.toUpperCase() as HttpVerb) &&
      routeMatches(rule.pattern, path),
  );
}
