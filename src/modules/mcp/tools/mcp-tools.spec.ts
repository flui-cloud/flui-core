import { APPLICATION_TOOLS } from './application.tools';
import { CATALOG_TOOLS } from './catalog.tools';
import {
  McpToolContext,
  ToolDef,
  resolveClusterId,
  runGated,
  runTool,
} from './mcp-tool.util';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { McpApiError } from '../services/mcp-api.client';
import { isInputRequired } from '../protocol/mrtr';
import { isOfferedToGuest } from '../services/sandbox-tool-visibility';
import { ACTION_PROPOSAL_CODE } from '../../action-cycle/action-cycle.core';

const find = (tools: ToolDef[], name: string): ToolDef => {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
};

interface Recorded {
  method: string;
  path: string;
  payload?: unknown;
}

/**
 * The API as a tool sees it. There is no `services` on the context any more, so
 * a stub of one would not even be reachable: whatever a tool does, it does as a
 * request, and this records which.
 */
const apiCtx = (
  reply: (call: Recorded) => unknown,
  calls: Recorded[] = [],
): McpToolContext & { calls: Recorded[] } => {
  const send = (method: string, path: string, payload?: unknown) => {
    const call = { method, path, payload };
    calls.push(call);
    return Promise.resolve(reply(call));
  };
  return {
    user: { userId: 'u1', email: 'e@x' },
    scopes: new Set<string>(),
    allowDestructive: true,
    audit: { record: jest.fn() },
    surface: 'mcp',
    calls,
    api: {
      get: (path: string, query?: unknown) => send('GET', path, query),
      post: (path: string, payload?: unknown) => send('POST', path, payload),
      put: (path: string, payload?: unknown) => send('PUT', path, payload),
      patch: (path: string, payload?: unknown) => send('PATCH', path, payload),
      delete: (path: string) => send('DELETE', path),
    },
  } as unknown as McpToolContext & { calls: Recorded[] };
};

/** One cluster on the instance, so `resolveClusterId` settles without an argument. */
const oneCluster = (call: Recorded): unknown =>
  call.path === '/infrastructure/clusters' ? [{ id: 'c1' }] : undefined;

// run() argument types are validated at the MCP layer, not here.
const run = (tool: ToolDef, args: unknown, ctx: McpToolContext): unknown =>
  tool.run(args as never, ctx);

describe('MCP agent-facing tool surface', () => {
  describe('app_list', () => {
    const appList = find(APPLICATION_TOOLS, 'app_list');

    it('reads the cluster listing route, which is the one carrying the URLs', async () => {
      const enriched = [{ id: 'a1', name: 'it-tools', url: 'https://x/' }];
      const ctx = apiCtx((call) =>
        call.path === '/clusters/c1/applications' ? enriched : oneCluster(call),
      );

      const out = await run(appList, { status: 'running' }, ctx);

      expect(out).toBe(enriched);
      expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'GET /infrastructure/clusters',
        'GET /clusters/c1/applications',
      ]);
      expect(ctx.calls[1].payload).toMatchObject({ status: 'running' });
    });

    it('self-corrects an invalid enum filter instead of reaching the API at all', async () => {
      const ctx = apiCtx(oneCluster);
      // "database" is a kind, not a category — the model's common mistake.
      await expect(run(appList, { category: 'database' }, ctx)).rejects.toThrow(
        /Invalid category/,
      );
      expect(ctx.calls.some((c) => c.path.includes('/applications'))).toBe(
        false,
      );
    });

    // Token budget: the model must see only identity + status + the link, never
    // the full DTO (env, resources, metadata, …) which would bloat the context.
    it('forModel projects a slim shape and never leaks the full DTO', () => {
      const projected = appList.forModel!([
        {
          id: 'a1',
          name: 'it-tools',
          slug: 'it-tools-3l6a9w',
          status: 'running',
          kind: 'TOOL',
          url: 'https://it-tools-3l6a9w.nip.io/',
          // fields that must NOT reach the model:
          env: [{ name: 'SECRET', value: 'x' }],
          resources: { limits: { cpu: '1' } },
          metadata: { catalogInstallId: 'i1' },
        },
      ]) as Array<Record<string, unknown>>;

      expect(new Set(Object.keys(projected[0]))).toEqual(
        new Set(['id', 'name', 'slug', 'status', 'kind', 'url']),
      );
    });

    it('forModel falls back to internalUrl when there is no public url', () => {
      const projected = appList.forModel!([
        { id: 'a1', internalUrl: 'https://a.internal.flui/' },
      ]) as Array<{ url?: string }>;
      expect(projected[0].url).toBe('https://a.internal.flui/');
    });

    it('forModel states "no endpoint" explicitly when neither url is present', () => {
      const projected = appList.forModel!([
        { id: 'a1', name: 'immich-server' },
      ]) as Array<{ url?: string }>;
      expect(projected[0].url).toMatch(/no endpoint/i);
    });
  });

  describe('operation_status forModel', () => {
    const op = find(APPLICATION_TOOLS, 'operation_status');

    it('marks a running op not-done and tells the model never to claim completion', () => {
      const view = op.forModel!({
        id: 'op1',
        status: 'IN_PROGRESS',
        progress: 50,
        currentStepIndex: 0,
        totalSteps: 8,
      }) as { done: boolean; progress: number; step: string; note?: string };
      expect(view.done).toBe(false);
      expect(view.progress).toBe(50);
      expect(view.step).toBe('0/8');
      expect(view.note).toMatch(/never claim it completed/i);
    });

    it('surfaces the failure reason on a terminal failure', () => {
      const view = op.forModel!({
        id: 'op1',
        status: 'FAILED',
        errorMessage: 'insufficient resources',
      }) as { done: boolean; error?: string; note?: string };
      expect(view.done).toBe(true);
      expect(view.error).toBe('insufficient resources');
      expect(view.note).toMatch(/do NOT retry/);
    });
  });

  describe('app_debug forModel (failure diagnosis)', () => {
    const dbg = find(APPLICATION_TOOLS, 'app_debug');

    it('surfaces the crash reason + missing mounts + events, and drops the noise', () => {
      const view = dbg.forModel!([
        {
          name: 'immich-server-abc',
          phase: 'Pending',
          containers: [
            {
              name: 'server',
              ready: false,
              restartCount: 5,
              state: {
                waiting: {
                  reason: 'CrashLoopBackOff',
                  message: 'back-off 5m0s',
                },
              },
              // noise that must NOT reach the model:
              env: [{ name: 'DB_PASSWORD', value: 'secret' }],
              livenessProbe: { type: 'http', path: '/health' },
            },
          ],
          volumes: [
            { name: 'uploads', exists: true },
            { name: 'jwt-secret', exists: false },
          ],
          events: [
            {
              type: 'Warning',
              reason: 'BackOff',
              message: 'Back-off restarting',
              count: 9,
            },
          ],
          annotations: { huge: 'blob' },
        },
      ]) as Array<{
        pod: string;
        containers: Array<{ problem?: string }>;
        missingMounts: string[];
        events: unknown[];
      }>;

      expect(view[0].pod).toBe('immich-server-abc');
      expect(view[0].containers[0].problem).toBe(
        'CrashLoopBackOff: back-off 5m0s',
      );
      expect(view[0].missingMounts).toEqual(['jwt-secret']);
      expect(view[0].events).toHaveLength(1);
      // credentials + bulky spec fields never reach the model:
      const serialized = JSON.stringify(view[0]);
      expect(serialized).not.toContain('DB_PASSWORD');
      expect(serialized).not.toContain('livenessProbe');
    });
  });

  describe('app_install (async operation handle)', () => {
    const install = find(CATALOG_TOOLS, 'app_install');

    it('returns immediately with an operationId + done:false + a human label', async () => {
      const ctx = apiCtx((call) =>
        call.path === '/catalog/mariadb/install'
          ? {
              id: 'i1',
              displayName: 'MariaDB',
              status: 'PENDING',
              operationId: 'op1',
            }
          : oneCluster(call),
      );

      const out = (await run(
        install,
        { slug: 'mariadb', displayName: 'MariaDB' },
        ctx,
      )) as Record<string, unknown>;
      // The contract collectOperationPending() depends on: operationId + done.
      expect(out.operationId).toBe('op1');
      expect(out.done).toBe(false);
      expect(out.label).toBe('Install MariaDB');
      expect(out.installId).toBe('i1');
    });

    // The handle is built from the install response, so nothing is read back:
    // the follow-up read used to cost a round trip and, on the infrastructure
    // route, a refusal for anyone but an administrator.
    it('does not go back to the API to describe what it just started', async () => {
      const ctx = apiCtx((call) =>
        call.path === '/catalog/mariadb/install'
          ? { id: 'i1', displayName: 'MariaDB', status: 'PENDING' }
          : oneCluster(call),
      );

      await run(install, { slug: 'mariadb', displayName: 'MariaDB' }, ctx);

      expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'GET /infrastructure/clusters',
        'POST /catalog/mariadb/install',
      ]);
    });
  });

  describe('app_uninstall / app_delete routing (removeApplication)', () => {
    const uninstall = find(CATALOG_TOOLS, 'app_uninstall');

    // The routing itself now lives on the route (AppRemovalController) and is
    // covered by its own spec. What matters here is that the tool asks ONCE,
    // asks the removal route, and relays what came back — the four reads it
    // used to interleave are gone, and with them the window between deciding
    // and removing.
    it('asks the removal route once and relays the whole-install answer', async () => {
      const ctx = apiCtx(() => ({
        removed: 'catalog-install',
        operationId: 'op2',
        status: 'IN_PROGRESS',
        done: false,
        label: 'Uninstall Immich',
      }));

      const out = (await run(uninstall, { id: 'a1' }, ctx)) as Record<
        string,
        unknown
      >;
      expect(ctx.calls).toEqual([
        {
          method: 'DELETE',
          path: '/applications/a1/install',
          payload: undefined,
        },
      ]);
      expect(out.removed).toBe('catalog-install');
      expect(out.label).toBe('Uninstall Immich');
      expect(out.done).toBe(false);
    });

    it('is idempotent: a removal already underway comes back as a state, not a second uninstall', async () => {
      const ctx = apiCtx(() => ({
        removed: 'catalog-install',
        operationId: 'op-prev',
        status: 'IN_PROGRESS',
        done: false,
        alreadyUnderway: true,
      }));

      const out = (await run(uninstall, { id: 'a1' }, ctx)) as Record<
        string,
        unknown
      >;
      expect(out.done).toBe(false);
      expect(out.note).toContain('already being removed');
      expect(ctx.calls).toHaveLength(1);
    });

    it('relays a single-app delete the same way', async () => {
      const ctx = apiCtx(() => ({
        removed: 'application',
        operationId: 'op3',
        status: 'PENDING',
        done: false,
        label: 'Delete immich-web',
      }));

      const out = (await run(uninstall, { id: 'a1' }, ctx)) as Record<
        string,
        unknown
      >;
      expect(out.removed).toBe('application');
      expect(out.label).toBe('Delete immich-web');
    });
  });

  describe('app_deploy_image (bring-your-own image, first deploy)', () => {
    const deployImage = find(APPLICATION_TOOLS, 'app_deploy_image');

    it('creates the application on the resolved cluster, sourced from the image, and starts a deploy', async () => {
      const ctx = apiCtx((call) =>
        call.path === '/clusters/c1/applications'
          ? {
              application: {
                id: 'a1',
                name: 'my-api',
                slug: 'my-api-3l6a9w',
                status: 'PENDING',
              },
              operation: { id: 'op1', status: 'PENDING' },
            }
          : oneCluster(call),
      );

      const out = (await run(
        deployImage,
        {
          image: 'ghcr.io/acme/api:1.4.0',
          name: 'my-api',
          port: 3000,
          exposure: 'internal',
          env: { NODE_ENV: 'production' },
        },
        ctx,
      )) as Record<string, unknown>;

      // clusterId auto-resolved, exactly like every other cluster-scoped tool.
      expect(ctx.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'GET /infrastructure/clusters',
        'POST /clusters/c1/applications',
      ]);
      const body = ctx.calls[1].payload as Record<string, unknown>;
      expect(body.sourceType).toBe('docker_image');
      expect(body.sourceConfig).toEqual({
        type: 'docker_image',
        imageRef: 'ghcr.io/acme/api:1.4.0',
      });
      expect(body.port).toBe(3000);
      expect(body.exposure).toBe('internal');
      expect(body.env).toEqual([{ name: 'NODE_ENV', value: 'production' }]);
      // The whole point is to SHIP the image, not merely record it.
      expect(body.autoDeploy).toBe(true);

      expect(out.id).toBe('a1');
      expect(out.slug).toBe('my-api-3l6a9w');
      expect(out.operationId).toBe('op1');
      expect(out.done).toBe(false);
      expect(out.label).toBe('Deploy my-api');
    });

    it('rejects with the same actionable message as every other cluster-scoped tool when the cluster is ambiguous', async () => {
      const ctx = apiCtx((call) =>
        call.path === '/infrastructure/clusters'
          ? [
              { id: 'c1', name: 'one' },
              { id: 'c2', name: 'two' },
            ]
          : undefined,
      );

      await expect(
        run(deployImage, { image: 'nginx:1.25', name: 'x' }, ctx),
      ).rejects.toThrow(/Several clusters/);
      // Never reached the create route with an unresolved target.
      expect(ctx.calls.some((c) => c.path.includes('/applications'))).toBe(
        false,
      );
    });

    it('relays the API refusal verbatim when the image does not exist (DockerHub verification, 400)', async () => {
      const ctx = apiCtx((call) =>
        call.path === '/clusters/c1/applications'
          ? Promise.reject(
              new McpApiError(
                400,
                'Docker image not found: acme/does-not-exist:latest. Please verify the image name and tag on DockerHub.',
                'POST',
                '/clusters/c1/applications',
              ),
            )
          : oneCluster(call),
      );

      await expect(
        run(
          deployImage,
          { image: 'acme/does-not-exist:latest', name: 'x' },
          ctx,
        ),
      ).rejects.toThrow(/Docker image not found/);
    });

    // The route carries `@ActionCycle`: a credential with no standing approval
    // gets a proposal instead of an effect. Nothing in the tool body handles
    // this — `runGated` already turns it into an `input_required` wait — so
    // what this pins is that the wiring actually reaches that branch for
    // THIS route, not merely that the generic mechanism exists somewhere.
    it('comes back as input_required, not a failure, when the action cycle asks a person first', async () => {
      const ctx = {
        user: { userId: 'u1', email: 'e@x' },
        scopes: new Set([MCP_SCOPE.APP_WRITE]),
        allowDestructive: true,
        surface: 'mcp',
        audit: { record: jest.fn() },
        api: {
          get: () => Promise.resolve([{ id: 'c1' }]),
          post: () => {
            return Promise.reject(
              new McpApiError(
                403,
                'This call needs a person to allow it first.',
                'POST',
                '/clusters/c1/applications',
                ACTION_PROPOSAL_CODE,
                undefined,
                {
                  proposalId: 'p-1',
                  action: 'POST /clusters/:clusterId/applications',
                  sentence: 'create applications in cluster c1',
                  offersAlways: true,
                  estimateWithheld: false,
                },
              ),
            );
          },
        },
      } as unknown as McpToolContext;

      const result = await runTool(ctx, deployImage, {
        image: 'nginx:1.25',
        name: 'x',
      });
      expect(isInputRequired(result)).toBe(true);
    });

    // Verified, not assumed: `/clusters/:clusterId/applications` is already
    // fenced open at 'full' for a sandbox guest ("Create an application of
    // your own", sandbox-fence-own.ts) — the same route the dashboard's own
    // deploy wizard uses for a guest's docker-image app. This tool reaches no
    // further than the guest already can, so it is offered exactly like
    // app_deploy is.
    it('is offered to a sandbox guest, matching the create route the fence already opens for one', () => {
      expect(isOfferedToGuest(deployImage)).toBe(true);
    });
  });

  describe('catalog_get_app forModel (installability for "can we install X?")', () => {
    const get = find(CATALOG_TOOLS, 'catalog_get_app');

    it('surfaces installable + missing requirements + only the required inputs', () => {
      const view = get.forModel!({
        name: 'IT-Tools',
        slug: 'it-tools',
        installable: false,
        notInstallableReason: 'dns_required',
        notInstallableDetails: { needs: ['dns', 'tls'] },
        userInputPrompts: [
          { name: 'adminPassword' }, // required (no default)
          { name: 'theme', default: 'dark' }, // optional
        ],
        dependencies: [{ ref: 'postgres', required: true }],
      }) as {
        installable: boolean;
        notInstallableReason?: string;
        missingRequirements?: unknown;
        requiredInputs: string[];
      };

      expect(view.installable).toBe(false);
      expect(view.notInstallableReason).toBe('dns_required');
      expect(view.missingRequirements).toEqual({ needs: ['dns', 'tls'] });
      expect(view.requiredInputs).toEqual(['adminPassword']);
    });
  });
});

describe('resolveClusterId (deterministic cluster selection)', () => {
  // Over the wire now, so what comes back is what THIS caller may see: "the
  // sole cluster" means the only one they can act on, not the only one there is.
  const ctx = (clusters: Array<{ id: string; name?: string }>) =>
    ({
      api: { get: jest.fn().mockResolvedValue(clusters) },
    }) as unknown as McpToolContext;

  it('auto-selects the sole cluster (no cluster_list round-trip needed)', async () => {
    await expect(resolveClusterId(ctx([{ id: 'c1' }]))).resolves.toBe('c1');
  });

  it('asks the API, and asks it for the cluster listing', async () => {
    const c = ctx([{ id: 'c1' }]);
    await resolveClusterId(c);
    expect(c.api.get).toHaveBeenCalledWith('/infrastructure/clusters');
  });

  it('honours an explicit id without listing', async () => {
    const c = ctx([]);
    await expect(resolveClusterId(c, 'given')).resolves.toBe('given');
    expect(c.api.get).not.toHaveBeenCalled();
  });

  it('throws an actionable message when none exist', async () => {
    await expect(resolveClusterId(ctx([]))).rejects.toThrow(/No clusters/);
  });

  it('asks for a clusterId (listing the options) when several exist', async () => {
    await expect(
      resolveClusterId(
        ctx([
          { id: 'c1', name: 'a' },
          { id: 'c2', name: 'b' },
        ]),
      ),
    ).rejects.toThrow(/Several clusters/);
  });
});

describe('runGated (scope + destructive security gate)', () => {
  const gateCtx = (
    scopes: string[],
    allowDestructive: boolean,
  ): McpToolContext =>
    ({
      user: { userId: 'u1', email: 'e@x' },
      scopes: new Set(scopes),
      allowDestructive,
      audit: { record: jest.fn() },
      services: {},
    }) as unknown as McpToolContext;

  it('refuses and audits when the required scope is missing (fn never runs)', async () => {
    const ctx = gateCtx([], true);
    const fn = jest.fn();
    const res = await runGated(ctx, 't', MCP_SCOPE.APP_READ, fn);
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/missing required scope/);
    expect(fn).not.toHaveBeenCalled();
    expect(ctx.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ allowed: false }),
    );
  });

  it('refuses a destructive tool when destructive is disabled', async () => {
    const ctx = gateCtx([MCP_SCOPE.APP_DESTRUCTIVE], false);
    const res = await runGated(ctx, 't', MCP_SCOPE.APP_DESTRUCTIVE, jest.fn());
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/destructive operations are disabled/);
  });

  it('runs and audits success when the scope is granted', async () => {
    const ctx = gateCtx([MCP_SCOPE.APP_READ], true);
    const res = await runGated(ctx, 't', MCP_SCOPE.APP_READ, () =>
      Promise.resolve({ ok: 1 }),
    );
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(res.content[0].text)).toEqual({ ok: 1 });
    expect(ctx.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ allowed: true }),
    );
  });

  it('surfaces a tool error as an error result (and still audits)', async () => {
    const ctx = gateCtx([MCP_SCOPE.APP_READ], true);
    const res = await runGated(ctx, 't', MCP_SCOPE.APP_READ, () =>
      Promise.reject(new Error('boom')),
    );
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/boom/);
  });
});
