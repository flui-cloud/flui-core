import { ONBOARDING_TOOLS } from './onboarding.tools';
import { McpToolContext, ToolDef } from './mcp-tool.util';
import { MCP_SCOPE } from '../constants/mcp-scopes';

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

const apiCtx = (
  reply: (call: Recorded) => unknown,
  calls: Recorded[] = [],
): McpToolContext & { calls: Recorded[] } => {
  const send = (method: string, path: string, payload?: unknown) => {
    const call = { method, path, payload };
    calls.push(call);
    const result = reply(call);
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
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

const SKILL = {
  version: '1.2.3',
  digest: 'abc123',
  filename: 'SKILL.md',
  mediaType: 'text/markdown',
  mcpEndpoint: 'http://api.test/api/v1/mcp',
  content: '# Working with Flui\n',
};

describe('get_started', () => {
  const tool = find(ONBOARDING_TOOLS, 'get_started');

  it('carries the one scope every scoped key gets unconditionally', () => {
    expect(tool.scope).toBe(MCP_SCOPE.ONBOARDING_READ);
  });

  it('reads the same document GET /auth/agent-skill hands over, and returns it verbatim', async () => {
    const ctx = apiCtx((call) =>
      call.path === '/auth/agent-skill' ? SKILL : {},
    );
    const result = await tool.run({}, ctx);
    expect(result).toEqual(SKILL);
  });

  it('checks in with the version it just read, so the issuer can see the connection is alive', async () => {
    const ctx = apiCtx((call) =>
      call.path === '/auth/agent-skill' ? SKILL : { recorded: true },
    );
    await tool.run({}, ctx);
    const checkIn = ctx.calls.find(
      (c) => c.path === '/auth/agent-skill/check-in',
    );
    expect(checkIn).toEqual({
      method: 'POST',
      path: '/auth/agent-skill/check-in',
      payload: { skillVersion: SKILL.version },
    });
  });

  it('still returns the skill when the check-in call fails — a dropped announcement is not a failed read', async () => {
    const ctx = apiCtx((call) => {
      if (call.path === '/auth/agent-skill') return SKILL;
      if (call.path === '/auth/agent-skill/check-in') {
        return new Error('boom');
      }
      return {};
    });
    await expect(tool.run({}, ctx)).resolves.toEqual(SKILL);
  });
});
