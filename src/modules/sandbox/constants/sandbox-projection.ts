import { HttpVerb, routeMatches } from './sandbox-fence';

/**
 * The second half of the fence: what a guest sees *of* a response the fence has
 * let through.
 *
 * The allowlist works on whole routes, which is too blunt for the handful of
 * routes a guest needs but that answer for the whole instance. `GET
 * /infrastructure/clusters` is the case that forced this: without it the
 * dashboard has nothing to hang applications off and shows a guest zero of
 * everything, and with it raw a guest reads every cluster on the instance plus
 * node names and addresses.
 *
 * Projecting is done here rather than in each controller for the same reason
 * the fence is a guard and not a hidden button: one place decides, and the
 * answer is the same for the interface, the CLI and an agent holding the
 * guest's credential.
 */

/** Everything a projection is allowed to know about the caller. */
export interface SandboxScope {
  userId: string;
  /** The single cluster this tenancy lives on, from its own row. */
  clusterId: string | null;
  /** Projects holding at least one application the guest owns. */
  projectIds: ReadonlySet<string>;
  /** The applications the guest owns. */
  applicationIds: ReadonlySet<string>;
}

/** Which parts of the scope a rule reads. The interceptor loads no more. */
export type SandboxScopeField = 'clusterId' | 'projectIds' | 'applicationIds';

/** The route's own parameters, so a rule can pin a request to the guest's cluster. */
export type SandboxRouteParams = Record<string, string | undefined>;

export interface SandboxProjectionRule {
  verbs: HttpVerb[];
  pattern: string;
  needs: readonly SandboxScopeField[];
  project: (
    body: unknown,
    scope: SandboxScope,
    params: SandboxRouteParams,
  ) => unknown;
  why: string;
}

const asArray = (body: unknown): Record<string, unknown>[] =>
  Array.isArray(body) ? (body as Record<string, unknown>[]) : [];

const asObject = (body: unknown): Record<string, unknown> | null =>
  body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;

const pick = <T extends Record<string, unknown>>(
  source: T,
  keys: readonly string[],
): Record<string, unknown> =>
  Object.fromEntries(keys.map((k) => [k, source[k]]));

/**
 * A cluster as a guest may see it: enough to know the thing is real and running,
 * with nothing that names or locates a machine.
 *
 * Dropped on purpose: `masterIpAddress`, every node's `serverName`,
 * `ipAddress` and `vnetInfo`, the VNet identifiers and the Grafana datasource
 * handles. Node count and node health stay — they are the part that shows a
 * guest this is a real cluster and not a screenshot — and a node's id stays
 * because the interface keys lists by it while every route that would accept
 * one is refused by the fence.
 */
function projectCluster(
  cluster: Record<string, unknown>,
): Record<string, unknown> {
  const nodes = Array.isArray(cluster.nodes)
    ? (cluster.nodes as Record<string, unknown>[])
    : [];
  return {
    id: cluster.id,
    name: cluster.name,
    provider: cluster.provider,
    region: cluster.region,
    status: cluster.status,
    clusterType: cluster.clusterType,
    nodeCount: cluster.nodeCount,
    createdAt: cluster.createdAt,
    updatedAt: cluster.updatedAt,
    nodes: nodes.map(projectNode),
  };
}

/**
 * A node without a way to reach it. What is left says how many machines there
 * are and whether they are healthy — which is the whole point of showing them —
 * and nothing that would let anyone knock on one.
 */
function projectNode(node: Record<string, unknown>): Record<string, unknown> {
  return {
    id: node.id,
    nodeType: node.nodeType,
    status: node.status,
    createdAt: node.createdAt,
  };
}

/**
 * An endpoint as its owner may see it: the public name, whether TLS is on it and
 * how the certificate is going. Not the DNS record it is written into nor the
 * address behind it — the guest is being shown that the certificate is real, not
 * handed the instance's DNS plumbing.
 */
const ENDPOINT_FIELDS = [
  'id',
  'applicationId',
  'clusterId',
  'endpointType',
  'hostnameMode',
  'fqdn',
  'certChallenge',
  'certificateRequired',
  'certificateProvider',
  'certificateStatus',
  'certificateMessage',
  'certificateExpiresAt',
  'tlsEnabled',
  'reconciliationStatus',
  'lastReconciliationAt',
  'createdAt',
  'updatedAt',
] as const;

export const SANDBOX_PROJECTIONS: SandboxProjectionRule[] = [
  {
    verbs: ['GET'],
    pattern: '/infrastructure/clusters',
    needs: ['clusterId'],
    why: 'Only the cluster this tenancy runs on, without machine names or addresses.',
    project: (body, scope) =>
      asArray(body)
        .filter((cluster) => cluster.id === scope.clusterId)
        .map(projectCluster),
  },
  {
    verbs: ['GET'],
    pattern: '/projects',
    needs: ['projectIds'],
    why: 'Only projects that hold an application the guest owns.',
    project: (body, scope) =>
      asArray(body).filter(
        (project) =>
          typeof project.id === 'string' && scope.projectIds.has(project.id),
      ),
  },
  {
    verbs: ['GET'],
    pattern: '/infrastructure/clusters/:id',
    needs: ['clusterId'],
    why: 'The tenancy\u2019s own cluster, or nothing at all.',
    project: (body, scope) => {
      const cluster = asObject(body);
      if (!cluster) return null;
      if (cluster.id !== scope.clusterId) return null;
      return projectCluster(cluster);
    },
  },
  {
    // The cluster is in the path and not in the rows, so the pin has to be on
    // the parameter: asking for another cluster's nodes returns nothing rather
    // than that cluster's shape with the names taken off.
    verbs: ['GET'],
    pattern: '/infrastructure/clusters/:id/nodes',
    needs: ['clusterId'],
    why: 'How many nodes and how they are, for the tenancy\u2019s own cluster only.',
    project: (body, scope, params) =>
      params.id === scope.clusterId ? asArray(body).map(projectNode) : [],
  },
  {
    // The zone the guest's own applications are published under, so the first
    // screen can stop offering to "set up DNS & certificates" on an instance
    // where both are already done. `acmeEmail` is the operator's own address and
    // `errorMessage` is their plumbing; neither is the guest's business.
    verbs: ['GET'],
    pattern: '/clusters/:clusterId/dns-zone/list',
    needs: ['clusterId'],
    why: 'The zone assignment of the tenancy\u2019s own cluster, without the operator\u2019s address.',
    project: (body, scope, params) => {
      if (params.clusterId !== scope.clusterId) return [];
      return asArray(body).map((assignment) =>
        pick(assignment, [
          'id',
          'clusterId',
          'dnsZoneId',
          'dnsZone',
          'certificateProvider',
          'wildcardCertificate',
          'reconciliationStatus',
          'lastReconciliationAt',
          'createdAt',
          'updatedAt',
        ]),
      );
    },
  },
  {
    verbs: ['GET'],
    pattern: '/clusters/:clusterId/endpoints',
    needs: ['applicationIds'],
    why: "Only the endpoints of the guest's own applications.",
    project: (body, scope) =>
      asArray(body)
        .filter(
          (endpoint) =>
            typeof endpoint.applicationId === 'string' &&
            scope.applicationIds.has(endpoint.applicationId),
        )
        .map((endpoint) => pick(endpoint, ENDPOINT_FIELDS)),
  },
  {
    // History carries the same node labels as the live reading, so it takes the
    // same treatment rather than a second, subtly different one.
    verbs: ['GET'],
    pattern: '/observability/clusters/:clusterId/metrics/history',
    needs: ['clusterId'],
    why: 'How the nodes have been doing, without saying where they are.',
    project: (body, scope, params) => {
      if (params.clusterId !== scope.clusterId) return { servers: [] };
      const history = asObject(body);
      if (!history) return body;
      const servers = Array.isArray(history.servers)
        ? (history.servers as Record<string, unknown>[])
        : [];
      return {
        ...history,
        servers: servers.map(({ instance: _instance, ...rest }) => rest),
      };
    },
  },
  {
    verbs: ['GET'],
    pattern: '/observability/clusters/:clusterId/metrics',
    needs: ['clusterId'],
    why: 'How the nodes are doing, without saying where they are.',
    project: (body, scope, params) => {
      if (params.clusterId !== scope.clusterId) return { servers: [] };
      const metrics = asObject(body);
      if (!metrics) return body;
      const servers = Array.isArray(metrics.servers)
        ? (metrics.servers as Record<string, unknown>[])
        : [];
      return {
        ...metrics,
        // `instance` is a node's address and port. The load on a node is the
        // part that shows the cluster is alive; where to reach it is not.
        servers: servers.map(({ instance: _instance, ...rest }) => rest),
      };
    },
  },
];

export function findSandboxProjection(
  verb: string,
  path: string,
): SandboxProjectionRule | undefined {
  return SANDBOX_PROJECTIONS.find(
    (rule) =>
      rule.verbs.includes(verb.toUpperCase() as HttpVerb) &&
      routeMatches(rule.pattern, path),
  );
}
