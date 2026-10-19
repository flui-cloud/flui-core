import { ALL_TOOLS, findTool } from '../../mcp/tools/tool-registry';
import { isOfferedToGuest } from '../../mcp/services/sandbox-tool-visibility';
import { SCOPE_TIER } from '../../mcp/constants/mcp-scopes';
import { McpScopeResolver } from '../../mcp/services/mcp-scope.resolver';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';
import { GUEST_ASSISTANT_TOOLS } from './guest-assistant-tools';
import { toolsForUser } from './assistant-turn.util';
import type { AgentRunContext } from './assistant-agent.service';

const guest: AuthenticatedUser = {
  userId: 'guest-1',
  email: 'guest@try.flui.cloud',
  roles: {},
  role: IdentityRole.USER,
  isAdmin: false,
};

function ctx(isSandbox: boolean): AgentRunContext {
  return {
    scopes: new McpScopeResolver().resolve(guest, isSandbox),
    isSandbox,
  } as unknown as AgentRunContext;
}

describe('the dashboard assistant’s tools for a guest', () => {
  const names = Object.keys(GUEST_ASSISTANT_TOOLS);

  it('is about twenty tools', () => {
    expect(names.length).toBeGreaterThanOrEqual(18);
    expect(names.length).toBeLessThanOrEqual(22);
  });

  it.each(Object.keys(GUEST_ASSISTANT_TOOLS))(
    '%s exists, reads only, and is one the fence offers a guest',
    (name) => {
      const def = findTool(name);
      expect(def).toBeDefined();
      expect(SCOPE_TIER[def!.scope]).toBe('read');
      expect(isOfferedToGuest(def!)).toBe(true);
      expect(GUEST_ASSISTANT_TOOLS[name].length).toBeGreaterThan(10);
    },
  );

  it('hands a guest only the picked tools, each with its short summary', () => {
    const offered = toolsForUser(ctx(true)).map((t) => t.function.name);
    expect(offered.length).toBeGreaterThan(0);
    for (const name of offered) expect(names).toContain(name);
    for (const tool of toolsForUser(ctx(true))) {
      expect(tool.function.description).toBe(
        findTool(tool.function.name)!.summary,
      );
    }
  });

  it('leaves everybody else the full list and the full descriptions', () => {
    const scopes = ctx(false).scopes;
    const expected = ALL_TOOLS.filter((d) => scopes.has(d.scope)).length;
    const tools = toolsForUser(ctx(false));
    expect(tools).toHaveLength(expected);
    for (const tool of tools) {
      expect(tool.function.description).toBe(
        findTool(tool.function.name)!.description,
      );
    }
  });
});
