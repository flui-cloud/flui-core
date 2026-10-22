import { TOPOLOGY_TOOLS } from './topology.tools';
import { McpToolContext, runTool } from './mcp-tool.util';
import { McpApiCaller } from '../services/mcp-api.client';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { isOfferedToGuest } from '../services/sandbox-tool-visibility';
import { exampleTopology } from '../../sandbox/stand-in/sandbox-world-topology';

const QUIET = 1792663200000;
const tool = TOPOLOGY_TOOLS[0];

function ctxWith(paths: string[]): McpToolContext {
  const api = {
    get: (path: string) => {
      paths.push(path);
      return Promise.resolve(exampleTopology(QUIET));
    },
  } as unknown as McpApiCaller;
  return {
    user: { userId: 'u1', email: 'agent@flui.cloud' },
    scopes: new Set<string>([MCP_SCOPE.APP_READ]),
    allowDestructive: false,
    surface: 'mcp',
    actor: { kind: 'agent', keyId: 'k1' },
    audit: { record: jest.fn().mockResolvedValue(undefined) },
    api,
  } as unknown as McpToolContext;
}

async function call(args: Record<string, unknown>) {
  const paths: string[] = [];
  const result = await runTool(ctxWith(paths), tool, args);
  const text = (result as { content: Array<{ text: string }> }).content[0].text;
  return {
    paths,
    result,
    body: (result as { isError?: boolean }).isError ? text : JSON.parse(text),
  };
}

describe('topology_get', () => {
  it('is a read on the topology route, for app readers', () => {
    expect(tool.name).toBe('topology_get');
    expect(tool.scope).toBe(MCP_SCOPE.APP_READ);
    expect(tool.routes).toEqual(['GET /topology']);
  });

  it('is not offered to a sandbox guest, whose topology is the example world', () => {
    expect(isOfferedToGuest(tool)).toBe(false);
  });

  it('reads the whole fleet with what needs attention', async () => {
    const { paths, body } = await call({});
    expect(paths).toEqual(['/topology']);
    expect(body.focus).toBe('fleet');
    expect(body.clusters.map((c: { name: string }) => c.name)).toEqual([
      'production',
      'staging',
      'flui-control',
    ]);
    expect(body.needsAttention[0]).toMatchObject({
      label: 'Worker',
      severity: 'warning',
    });
    expect(
      body.apps.every((a: { name: string }) => !a.name.startsWith('Flui')),
    ).toBe(true);
  });

  it('asks for the platform apps only when told to', async () => {
    const { paths } = await call({ system: 'true' });
    expect(paths).toEqual(['/topology?system=1']);
  });

  it('focuses one app, with who calls it, what it talks to and where it runs', async () => {
    const { body } = await call({ app: 'storefront', cluster: 'production' });
    expect(body).toMatchObject({
      focus: 'app',
      name: 'Storefront',
      cluster: 'production',
      exposure: 'public',
    });
    expect(body.talksTo).toEqual([
      expect.objectContaining({ name: 'API', port: ':8080' }),
    ]);
    expect(body.runsOn.map((r: { server: string }) => r.server).sort()).toEqual(
      ['production-2', 'production-3'],
    );
    expect(body.routes[0].requestsPerSecond).toBeGreaterThan(0);
  });

  it('focuses one cluster and folds the platform into a summary', async () => {
    const { body } = await call({ cluster: 'flui-control' });
    expect(body.focus).toBe('cluster');
    expect(body.apps).toEqual([]);
    expect(body.platform).toMatchObject({ apps: 12, status: 'running' });
  });

  it('focuses one server with the apps on it', async () => {
    const { body } = await call({ server: 'production-2' });
    expect(body).toMatchObject({
      focus: 'server',
      name: 'production-2',
      cluster: 'production',
    });
    expect(body.apps.map((a: { name: string }) => a.name)).toContain(
      'Storefront',
    );
  });

  it('refuses an ambiguous name with the candidates', async () => {
    const { result, body } = await call({ app: 'api' });
    expect((result as { isError?: boolean }).isError).toBe(true);
    expect(body).toContain('"api" matches 2 apps');
  });
});
