import { ALL_TOOLS } from './tool-registry';
import { McpToolContext, ToolDef, runTool } from './mcp-tool.util';
import { McpApiCaller } from '../services/mcp-api.client';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { routeMatches } from '../../sandbox/constants/sandbox-fence';

/**
 * Strada B, tappa 2 — the whole catalogue, not a slice.
 *
 * The claim this file exists to make checkable is a counting one: every tool
 * Flui publishes reaches the product through the API, as the caller, so the
 * guards on the routes are the authorization. The old shape of the bypass — a
 * `services` bag on the tool context — is gone from the type, so a tool that
 * wanted to go around the guards would no longer compile; what is still worth
 * pinning is that each tool actually goes somewhere, and that it goes to the
 * route whose gate is the one meant to decide.
 */

/** Arguments that satisfy each tool's schema. Values are inert on purpose. */
const ARGS: Record<string, Record<string, unknown>> = {
  catalog_search: {},
  catalog_get_app: { slug: 'mariadb' },
  app_install: { slug: 'mariadb', displayName: 'MariaDB' },
  app_uninstall: { id: 'a1' },
  spec_validate: { yaml: 'kind: Application' },
  access_revocation_preview: { grantId: 'g1' },
  access_grant_list: {},
  access_grant_add: {
    principalType: 'user',
    principalRef: 'bob@acme.com',
    role: 'viewer',
    scopeType: 'global',
  },
  access_grant_remove: { grantId: 'g1' },
  cluster_list: {},
  cluster_resources: {},
  cluster_orphaned_volumes: {},
  dns_wildcard_status: {},
  dns_wildcard_publish: {},
  operation_status: { operationId: 'op1' },
  app_list: {},
  app_get: { id: 'a1' },
  app_status: { id: 'a1' },
  app_debug: { id: 'a1' },
  app_releases: { id: 'a1' },
  app_events: { id: 'a1' },
  app_deploy_from_yaml: { yaml: 'kind: Application' },
  app_deploy: { id: 'a1' },
  app_scale: { id: 'a1', replicas: 2 },
  app_restart: { id: 'a1' },
  app_stop: { id: 'a1' },
  app_start: { id: 'a1' },
  app_delete: { id: 'a1' },
  app_removal_preview: { id: 'a1' },
  app_traffic: { id: 'a1' },
  app_alerts: { id: 'a1' },
  log_sources: {},
  app_logs: {},
  template_list: {},
  template_get: { framework: 'nextjs' },
  repo_list: {},
  integration_status: {},
  github_setup: {},
  github_connect: {},
  repo_connect: { repository: 'acme/api' },
  backup_status: {},
  backup_policy_list: {},
  backup_run: { policyId: 'p1' },
  backup_policy_pause: { policyId: 'p1' },
  backup_policy_resume: { policyId: 'p1' },
  migrate_app: { srcAppId: 'a1', targetClusterId: 'c2' },
  migrate_db: { srcAppId: 'a1', targetClusterId: 'c2' },
  migrate_full: { appId: 'a1', dbAppId: 'd1', targetClusterId: 'c2' },
  migration_list: {},
  migration_get: { type: 'app', id: 'm1' },
  migration_cutover: { type: 'app', id: 'm1' },
  migration_abort: { type: 'app', id: 'm1' },
  migration_destroy_source: { type: 'app', id: 'm1' },
  schedule_list: { id: 'a1' },
  schedule_create: {
    id: 'a1',
    name: 'nightly',
    schedule: '0 2 * * *',
    command: 'echo hi',
  },
  schedule_trigger: { id: 'a1', name: 'nightly' },
  schedule_runs: { id: 'a1', name: 'nightly' },
  schedule_delete: { id: 'a1', name: 'nightly' },
  gateway_list_routes: { id: 'a1' },
  gateway_route_add: { id: 'a1', host: 'api.example.com' },
  gateway_set_policy: { id: 'a1', endpointId: 'e1' },
  gateway_status: { id: 'a1' },
  gateway_route_compiled: { id: 'a1', endpointId: 'e1' },
  gateway_route_remove: { id: 'a1', endpointId: 'e1' },
  mail_readiness: {},
  mail_events: {},
  mail_suppressions: {},
  app_variable_request: { applicationId: 'a1', key: 'STRIPE_SECRET_KEY' },
  operating_context_read: {},
  my_permissions: {},
  // An explicit revision on purpose: without one the tool reads the revision
  // history first, and the stand-in API answers every unlisted path with one
  // object rather than a list. Choosing the target from that history is pinned
  // in `self-service.tools.spec.ts`, where the history can be described.
  app_rollback: { id: 'a1', revisionNumber: 2 },
  app_set_resources: { id: 'a1', limits: { memory: '512Mi' } },
  app_reconcile: { id: 'a1' },
  app_metrics: { id: 'a1' },
  app_variables: { applicationId: 'a1' },
  app_variable_set: { applicationId: 'a1', variables: { LOG_LEVEL: 'debug' } },
  cluster_capacity_plan: {},
  cluster_node_list: {},
  cluster_node_scale_preview: { nodeId: 'n1' },
  cluster_storage_status: {},
  platform_component_list: {},
  dns_issuer_list: {},
  dns_internal_hosting: {},
  san_certificate_list: {},
  cluster_create: {
    name: 'prod',
    provider: 'hetzner',
    region: 'fsn1',
    nodeSize: 'cx22',
    workerCount: 1,
  },
  cluster_node_add: { count: 1 },
  cluster_node_remove: { nodeId: 'n1' },
  cluster_node_resize: { nodeId: 'n1', targetServerType: 'cx32' },
  cluster_node_uncordon: { nodeId: 'n1' },
  cluster_storage_expand: { targetSizeGb: 100 },
  cluster_power: { action: 'stop' },
  cluster_autoscale_set: { autoscalingEnabled: true },
  cluster_firewall_enable: {},
  platform_component_redeploy: { componentKey: 'traefik' },
  dns_issuer_configure: { type: 'http', acmeEmail: 'ops@example.com' },
  san_certificate_create: {
    name: 'multi',
    fqdns: ['a.example.com'],
    certChallenge: 'http-01',
  },
  mail_domain_publish: { domain: 'example.com' },
};

interface Recorded {
  method: string;
  path: string;
}

/** Whatever each path has to answer for the tool bodies to run to the end. */
const ARRAY_PATHS = [
  /^\/templates$/,
  /^\/repositories$/,
  /^\/mail\/(events|suppressions)$/,
  /^\/backup-policies$/,
  /^\/clusters\/[^/]+\/applications$/,
  /^\/applications\/[^/]+\/(schedules|resources)$/,
  /^\/applications\/[^/]+\/schedules\/[^/]+\/runs$/,
  /^\/applications\/[^/]+\/gateway\/routes$/,
  /^\/applications\/[^/]+\/debug\/pods$/,
];

function replyFor(path: string): unknown {
  if (path === '/infrastructure/clusters') return [{ id: 'c1', name: 'one' }];
  if (ARRAY_PATHS.some((re) => re.test(path))) return [];
  if (path.endsWith('/storage/orphaned-claims')) {
    return {
      clusterId: 'c1',
      namespacesScanned: ['user-a1b2c3'],
      claims: [],
      totalBytes: 0,
      totalLabel: '0 B',
    };
  }
  if (path.endsWith('/resource-availability')) {
    return {
      canDeploy: true,
      reason: null,
      autoscalingEnabled: false,
      used: { cpu: '100m', memory: '512Mi' },
      total: { cpu: '2', memory: '4Gi' },
      available: { cpu: '1900m', memory: '3.5Gi' },
    };
  }
  if (path === '/catalog') return [{ slug: 'mariadb', name: 'MariaDB' }];
  // The cluster controller answers its async routes in snake case, which is the
  // shape the infrastructure-operation tools normalise before reporting a handle.
  if (
    /(workers|\/stop|\/start)$/.test(path) ||
    path === '/infrastructure/clusters'
  ) {
    return { operation_id: 'op1', status: 'pending' };
  }
  if (path === '/operating-context/advice') {
    return { preamble: 'p', advice: [], needsReview: [], conflicts: [] };
  }
  if (path.endsWith('/dns-zone/list')) return [{ id: 'z1', dnsZone: {} }];
  if (path.endsWith('/releases')) return { releases: [] };
  if (path.endsWith('/alerts')) return { alerts: [], firing: 0 };
  if (path.endsWith('/operations')) return { items: [{ id: 'op1' }] };
  if (path === '/repositories/import') {
    return { repositories: [{ id: 'r1', fullName: 'acme/api', status: 'ok' }] };
  }
  if (path.startsWith('/repositories/github-app/install-url')) {
    return { alreadyConnected: false, installUrl: 'https://github.test/i' };
  }
  if (path.startsWith('/variables/')) {
    return { data: {}, sensitiveKeys: [], pendingKeys: ['STRIPE_SECRET_KEY'] };
  }
  if (path === '/applications/a1') return { id: 'a1', slug: 'my-api' };
  if (path.endsWith('/install') && path.startsWith('/catalog/')) {
    return { id: 'i1', displayName: 'MariaDB', status: 'PENDING' };
  }
  if (path.endsWith('/install')) {
    return {
      removed: 'application',
      operationId: 'op1',
      status: 'PENDING',
      done: false,
    };
  }
  if (path.endsWith('-migrations')) return [];
  return {
    id: 'x1',
    status: 'PENDING',
    infrastructureOperationId: 'op1',
    manifestJson: {},
    githubUrl: 'https://github.test/manifest',
    state: 's1',
  };
}

function ctxFor(calls: Recorded[]): McpToolContext {
  const send = (method: string, path: string) => {
    calls.push({ method, path });
    return Promise.resolve(replyFor(path)) as Promise<never>;
  };
  const api: McpApiCaller = {
    get: (path) => send('GET', path),
    post: (path) => send('POST', path),
    put: (path) => send('PUT', path),
    patch: (path) => send('PATCH', path),
    delete: (path) => send('DELETE', path),
  };
  return {
    user: { userId: 'u1', email: 'agent@flui.cloud' },
    scopes: new Set<string>(Object.values(MCP_SCOPE)),
    allowDestructive: true,
    surface: 'mcp',
    audit: { record: jest.fn().mockResolvedValue(undefined) },
    api,
  } as unknown as McpToolContext;
}

const find = (name: string): ToolDef => {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
};

async function pathsOf(name: string): Promise<Recorded[]> {
  const calls: Recorded[] = [];
  const result = await runTool(ctxFor(calls), find(name), ARGS[name]);
  const body = (result as { content?: Array<{ text: string }> }).content?.[0]
    ?.text;
  if ((result as { isError?: boolean }).isError) {
    throw new Error(`${name} came back as an error: ${body}`);
  }
  return calls;
}

describe('strada B — the whole tool catalogue goes over the wire', () => {
  it('has an argument set for every published tool, and no stragglers', () => {
    const byName = (a: string, b: string) => a.localeCompare(b);
    expect(ALL_TOOLS.map((t) => t.name).sort(byName)).toEqual(
      Object.keys(ARGS).sort(byName),
    );
  });

  it.each(ALL_TOOLS.map((t) => t.name))(
    '%s reaches the product only by calling the API',
    async (name) => {
      const calls = await pathsOf(name);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call.path.startsWith('/')).toBe(true);
    },
  );

  it('offers the tool context no way to reach a service at all', () => {
    const ctx = ctxFor([]) as unknown as Record<string, unknown>;
    // The bypass is not merely unused: `McpServices` is off the type, so there
    // is nothing on the context a future tool could reach for by accident.
    expect(ctx.services).toBeUndefined();
    expect(Object.keys(ctx)).not.toContain('services');
  });

  /**
   * One row per tool whose gate is the reason the conversion was done at all.
   * If a route ever moves, this is what says so out loud instead of quietly
   * sending an agent somewhere with a different gate on it.
   */
  it.each([
    ['app_get', 'GET /applications/a1'],
    ['app_status', 'GET /applications/a1/runtime'],
    ['app_restart', 'POST /applications/a1/restart'],
    ['app_scale', 'PATCH /applications/a1/replicas'],
    ['app_stop', 'POST /applications/a1/stop'],
    ['app_start', 'POST /applications/a1/start'],
    ['app_events', 'GET /applications/a1/events'],
    ['app_releases', 'GET /applications/a1/releases'],
    ['app_debug', 'GET /applications/a1/debug/pods'],
    ['app_deploy', 'POST /applications/a1/deploy'],
    ['app_deploy_from_yaml', 'POST /applications/deploy-from-yaml'],
    ['app_delete', 'DELETE /applications/a1/install'],
    ['app_removal_preview', 'GET /applications/a1/removal-preview'],
    ['app_uninstall', 'DELETE /applications/a1/install'],
    ['app_traffic', 'GET /observability/applications/a1/traffic'],
    ['app_alerts', 'GET /observability/applications/a1/alerts'],
    ['schedule_list', 'GET /applications/a1/schedules'],
    ['schedule_delete', 'DELETE /applications/a1/schedules/nightly'],
    ['gateway_route_add', 'POST /applications/a1/gateway/routes'],
    ['gateway_status', 'GET /applications/a1/gateway/status'],
    ['gateway_route_remove', 'DELETE /applications/a1/gateway/routes/e1'],
    ['spec_validate', 'POST /catalog/validate'],
    ['app_install', 'POST /catalog/mariadb/install'],
    ['backup_run', 'POST /backup-jobs'],
    ['backup_policy_pause', 'POST /backup-policies/p1/pause'],
    ['migrate_app', 'POST /app-migrations'],
    ['migration_cutover', 'POST /app-migrations/m1/cutover'],
    ['migration_abort', 'DELETE /app-migrations/m1'],
    ['repo_list', 'GET /repositories'],
    ['repo_connect', 'POST /repositories/import'],
    [
      'github_setup',
      'POST /repositories/github/setup/github-app/manifest-start',
    ],
    ['github_connect', 'GET /repositories/github-app/install-url'],
    ['mail_readiness', 'GET /mail/readiness'],
    ['log_sources', 'GET /observability/clusters/c1/apps/log-sources'],
    ['app_logs', 'GET /observability/clusters/c1/apps/logs'],
    ['app_list', 'GET /clusters/c1/applications'],
    ['operation_status', 'GET /infrastructure/operations/op1'],
    [
      'cluster_orphaned_volumes',
      'GET /infrastructure/clusters/c1/storage/orphaned-claims',
    ],
    ['access_revocation_preview', 'GET /iam/grants/g1/revocation-preview'],
    ['access_grant_list', 'GET /iam/grants'],
    ['access_grant_add', 'POST /iam/grants'],
    ['access_grant_remove', 'DELETE /iam/grants/g1'],
    ['operating_context_read', 'GET /operating-context/advice'],
    // The machine room. Every write here lands on a route carrying
    // `@ActionCycle`, which is where the pause is — never in the tool.
    ['cluster_capacity_plan', 'GET /infrastructure/clusters/c1/capacity-plan'],
    ['cluster_create', 'POST /infrastructure/clusters'],
    ['cluster_node_add', 'POST /infrastructure/clusters/c1/workers'],
    ['cluster_node_remove', 'DELETE /infrastructure/clusters/c1/workers/n1'],
    ['cluster_power', 'POST /infrastructure/clusters/c1/stop'],
    [
      'cluster_storage_expand',
      'POST /infrastructure/clusters/c1/storage/expand',
    ],
    ['cluster_autoscale_set', 'PATCH /infrastructure/clusters/c1/autoscale'],
    ['cluster_firewall_enable', 'POST /firewalls/cluster/c1/enable'],
    [
      'platform_component_redeploy',
      'POST /infrastructure/clusters/c1/platform-components/traefik/actions/redeploy',
    ],
    [
      'dns_issuer_configure',
      'POST /clusters/c1/dns-zone/configure-issuer/http',
    ],
    ['san_certificate_create', 'POST /clusters/c1/san-certificates'],
    ['mail_domain_publish', 'POST /mail/domains/example.com/publish'],
  ])('%s lands on %s', async (name, expected) => {
    const calls = await pathsOf(name);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toContain(expected);
  });

  /**
   * The route decision 33 made the operator's own: an application's operations,
   * behind AppAccessGuard, instead of the infrastructure one behind a section
   * they do not hold.
   */
  it('reads an application operation through the application, when told which', async () => {
    const calls: Recorded[] = [];
    await runTool(ctxFor(calls), find('operation_status'), {
      operationId: 'op1',
      applicationId: 'a1',
    });
    expect(calls.map((c) => c.path)).toEqual(['/applications/a1/operations']);
  });

  it('escapes every identifier it receives instead of pasting it into a path', async () => {
    const calls: Recorded[] = [];
    await runTool(ctxFor(calls), find('schedule_runs'), {
      id: '../../secrets',
      name: 'a/b',
    });
    expect(calls[0].path).toBe(
      '/applications/..%2F..%2Fsecrets/schedules/a%2Fb/runs',
    );
  });

  /**
   * `routes` is a declaration of where a tool goes, and a declaration is only
   * worth anything while it is true. The visibility filter for a guest reads it
   * and asks the fence about it, so a tool that quietly moved to another route
   * would be offered — or hidden — on the strength of a sentence about a route
   * it no longer calls.
   *
   * The last call is the one checked because it is the one the tool is *about*:
   * everything before it is preparation — resolving the sole cluster, reading
   * an application before writing to it — and gates nothing the tool exists to
   * do.
   */
  describe('every tool says where it goes, and goes there', () => {
    it('declares at least one route for each tool', () => {
      const undeclared = ALL_TOOLS.filter((t) => !t.routes?.length).map(
        (t) => t.name,
      );
      expect(undeclared).toEqual([]);
    });

    it.each(ALL_TOOLS.map((t) => t.name))(
      '%s ends on a route it declared',
      async (name) => {
        const calls = await pathsOf(name);
        const last = calls[calls.length - 1];
        const declared = find(name).routes ?? [];
        const matched = declared.some((route) => {
          const [verb, pattern] = route.split(' ');
          return (
            verb === last.method &&
            routeMatches(pattern, last.path.split('?')[0])
          );
        });
        expect(
          matched ? true : `${last.method} ${last.path} not in ${declared}`,
        ).toBe(true);
      },
    );
  });

  /** Decision 40: the tool no longer carries a copy of the route's rule. */
  it('leaves github_setup with no gate of its own', async () => {
    const source = (
      find('github_setup').run as { toString(): string }
    ).toString();
    expect(source).not.toContain('isAdmin');
  });
});
