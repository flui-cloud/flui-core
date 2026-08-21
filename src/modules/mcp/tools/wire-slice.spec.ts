import { APPLICATION_TOOLS } from './application.tools';
import { GATEWAY_TOOLS } from './gateway.tools';
import { McpToolContext, ToolDef, runTool } from './mcp-tool.util';
import { McpApiCaller, McpApiError } from '../services/mcp-api.client';
import { MCP_SCOPE } from '../constants/mcp-scopes';

/**
 * Strada B, tappa 1 — the shape, pinned on the converted slice.
 *
 * The slice is deliberately mixed: `app_get` reads one application, `app_scale`
 * and `gateway_set_policy` write to one, `gateway_list_routes` reads many. What
 * it has to prove is not that HTTP works, but that the three things which get
 * lost in a rewrite survive it: the typed refusals with their behavioural
 * notes, the `forModel` projection, and the difference between "your grant does
 * not carry this tool" and "you may not touch this resource".
 */

const CONVERTED = [
  'app_get',
  'app_scale',
  'gateway_list_routes',
  'gateway_set_policy',
];

const ALL = [...APPLICATION_TOOLS, ...GATEWAY_TOOLS];

const find = (name: string): ToolDef => {
  const tool = ALL.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
};

/**
 * Every property access throws. A converted tool that still reached for a Nest
 * service would be walking past the guards, and this makes that impossible to
 * do by accident — the test fails on the reach, not on the assertion.
 */
const NO_SERVICES = new Proxy(
  {},
  {
    get(_t, prop) {
      throw new Error(
        `a converted tool reached for services.${String(prop)} — that call would bypass the guards`,
      );
    },
  },
) as never;

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

function stubApi(
  calls: Recorded[],
  reply: (r: Recorded) => unknown,
): McpApiCaller {
  const push = (method: string, path: string, body?: unknown) => {
    const call = { method, path, body };
    calls.push(call);
    return Promise.resolve(reply(call)).then((v) => v as never);
  };
  return {
    get: (path, query) => push('GET', path, query),
    post: (path, body) => push('POST', path, body),
    put: (path, body) => push('PUT', path, body),
    patch: (path, body) => push('PATCH', path, body),
    delete: (path) => push('DELETE', path),
  };
}

const audit = () => ({ record: jest.fn().mockResolvedValue(undefined) });

const ctxWith = (
  api: McpApiCaller,
  scopes: string[],
  auditRepo = audit(),
): McpToolContext =>
  ({
    user: { userId: 'u1', email: 'agent@flui.cloud' },
    scopes: new Set<string>(scopes),
    allowDestructive: false,
    surface: 'mcp',
    audit: auditRepo,
    services: NO_SERVICES,
    api,
  }) as unknown as McpToolContext;

const text = (result: unknown): string =>
  (result as { content: Array<{ text: string }> }).content[0].text;

describe('strada B — the converted slice goes over the wire', () => {
  it.each(CONVERTED)(
    '%s calls the API and never a Nest service',
    async (name) => {
      const calls: Recorded[] = [];
      const ctx = ctxWith(
        stubApi(calls, () => ({ id: 'a1', replicas: { desired: 1 } })),
        [MCP_SCOPE.APP_READ, MCP_SCOPE.APP_WRITE],
      );
      const tool = find(name);

      await runTool(ctx, tool, {
        id: 'a1',
        replicas: 2,
        endpointId: 'e1',
        sso: true,
      });

      expect(calls).toHaveLength(1);
      expect(calls[0].path.startsWith('/')).toBe(true);
    },
  );

  it('routes each converted tool at the controller that carries its gate', async () => {
    const seen: Record<string, Recorded> = {};
    for (const [name, args] of [
      ['app_get', { id: 'a1' }],
      ['app_scale', { id: 'a1', replicas: 3 }],
      ['gateway_list_routes', { id: 'a1' }],
      ['gateway_set_policy', { id: 'a1', endpointId: 'e1', clearAuth: true }],
    ] as const) {
      const calls: Recorded[] = [];
      const ctx = ctxWith(
        stubApi(calls, () => ({})),
        [MCP_SCOPE.APP_READ, MCP_SCOPE.APP_WRITE],
      );
      await runTool(ctx, find(name), args);
      seen[name] = calls[0];
    }

    expect(seen.app_get).toMatchObject({
      method: 'GET',
      path: '/applications/a1',
    });
    expect(seen.app_scale).toMatchObject({
      method: 'PATCH',
      path: '/applications/a1/replicas',
      body: { replicas: 3 },
    });
    expect(seen.gateway_list_routes).toMatchObject({
      method: 'GET',
      path: '/applications/a1/gateway/routes',
    });
    expect(seen.gateway_set_policy).toMatchObject({
      method: 'PATCH',
      path: '/applications/a1/gateway/routes/e1',
    });
  });

  it('escapes an identifier instead of pasting a model string into a path', async () => {
    const calls: Recorded[] = [];
    const ctx = ctxWith(
      stubApi(calls, () => ({})),
      [MCP_SCOPE.APP_READ],
    );

    await runTool(ctx, find('app_get'), {
      id: '../../infrastructure/clusters',
    });

    expect(calls[0].path).toBe(
      '/applications/..%2F..%2Finfrastructure%2Fclusters',
    );
  });

  describe('the two refusals stay two', () => {
    it('refuses on the scope BEFORE anything reaches the wire', async () => {
      const calls: Recorded[] = [];
      const auditRepo = audit();
      const ctx = ctxWith(
        stubApi(calls, () => ({})),
        [MCP_SCOPE.APP_READ],
        auditRepo,
      );

      const result = await runTool(ctx, find('app_scale'), {
        id: 'a1',
        replicas: 2,
      });

      expect(calls).toHaveLength(0);
      expect(text(result)).toContain("missing required scope 'mcp:app:write'");
      expect(text(result)).toContain('GRANT problem');
      expect(auditRepo.record).toHaveBeenCalledWith(
        expect.objectContaining({ allowed: false, error: 'missing scope' }),
      );
    });

    it('renders a guard refusal as access control, not as a missing scope', async () => {
      const auditRepo = audit();
      const ctx = ctxWith(
        stubApi([], () => {
          throw new McpApiError(
            403,
            "Not allowed to app:read on application 'someone-else'",
            'GET',
            '/applications/a2',
          );
        }),
        [MCP_SCOPE.APP_READ],
        auditRepo,
      );

      const result = await runTool(ctx, find('app_get'), { id: 'a2' });
      const message = text(result);

      expect(message).toContain('Refused by Flui access control (HTTP 403)');
      expect(message).toContain('NOT a scope problem');
      expect(message).not.toContain('missing required scope');
      // Recorded as denied: the scope let it through, the resource did not.
      expect(auditRepo.record).toHaveBeenCalledWith(
        expect.objectContaining({ allowed: false, tool: 'app_get' }),
      );
    });

    it('keeps a 404 from reading as a refusal', async () => {
      const ctx = ctxWith(
        stubApi([], () => {
          throw new McpApiError(
            404,
            'Application not found',
            'GET',
            '/applications/nope',
          );
        }),
        [MCP_SCOPE.APP_READ],
      );

      const message = text(await runTool(ctx, find('app_get'), { id: 'nope' }));

      expect(message).toContain('Not found (HTTP 404)');
      expect(message).not.toContain('Refused');
    });
  });

  describe('forModel survives the move', () => {
    it('still projects app_get down to the slim shape the model needs', async () => {
      const ctx = ctxWith(
        stubApi([], () => ({
          id: 'a1',
          name: 'it-tools',
          slug: 'it-tools-3l6a9w',
          status: 'running',
          kind: 'TOOL',
          url: 'https://it-tools.example/',
          // Everything below must NOT reach the model.
          env: [{ name: 'SECRET', value: 'x' }],
          resources: { limits: { cpu: '1' } },
          access: { tabs: ['overview'], readOnly: false },
        })),
        [MCP_SCOPE.APP_READ],
      );

      const projected = JSON.parse(
        text(await runTool(ctx, find('app_get'), { id: 'a1' })),
      ) as Record<string, unknown>;

      expect(projected.url).toBe('https://it-tools.example/');
      expect(projected).not.toHaveProperty('env');
      expect(projected).not.toHaveProperty('resources');
      expect(projected).not.toHaveProperty('access');
    });

    it('still projects app_scale down to the replica summary', async () => {
      const ctx = ctxWith(
        stubApi([], () => ({
          deploymentName: 'it-tools',
          replicas: { desired: 3, ready: 1, available: 1 },
          pods: [{ name: 'p1', containers: [{ env: 'lots' }] }],
        })),
        [MCP_SCOPE.APP_WRITE],
      );

      const projected = JSON.parse(
        text(await runTool(ctx, find('app_scale'), { id: 'a1', replicas: 3 })),
      ) as Record<string, unknown>;

      expect(projected).toEqual({
        app: 'it-tools',
        desired: 3,
        ready: 1,
        available: 1,
      });
    });
  });
});
