import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { McpScopeResolver } from './mcp-scope.resolver';
import { isOfferedToGuest } from './sandbox-tool-visibility';
import { ALL_TOOLS } from '../tools/tool-registry';
import {
  isExecutable,
  McpToolContext,
  toolInputSchema,
} from '../tools/mcp-tool.util';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';

/**
 * What `tools/list` advertises to an external agent, pinned per tool (name,
 * description, input schema) for an operator and for a sandbox guest. The
 * registry is shared with the dashboard assistant, which trims and shortens
 * what it offers its own model; none of that may leak into MCP. An intended
 * change regenerates the fixture with UPDATE_MCP_TOOLS_LIST=1.
 */
const FIXTURE = path.join(__dirname, '__fixtures__', 'mcp-tools-list.json');

const operator: AuthenticatedUser = {
  userId: 'op-1',
  email: 'op@acme.dev',
  roles: {},
  role: IdentityRole.ADMIN,
  isAdmin: true,
};
const guest: AuthenticatedUser = {
  userId: 'guest-1',
  email: 'guest@try.flui.cloud',
  roles: {},
  role: IdentityRole.USER,
  isAdmin: false,
};

function advertised(user: AuthenticatedUser, isSandbox: boolean) {
  const ctx = {
    scopes: new McpScopeResolver().resolve(user, isSandbox),
    allowDestructive: false,
  } as McpToolContext;
  const out: Record<string, string> = {};
  for (const def of ALL_TOOLS) {
    if (!isExecutable(ctx, def)) continue;
    if (isSandbox && !isOfferedToGuest(def)) continue;
    const wire = JSON.stringify({
      description: def.description,
      inputSchema: z.toJSONSchema(toolInputSchema(def.inputSchema)),
    });
    out[def.name] = createHash('sha256')
      .update(wire)
      .digest('hex')
      .slice(0, 16);
  }
  return out;
}

describe('MCP tools/list contract', () => {
  const current = {
    operator: advertised(operator, false),
    guest: advertised(guest, true),
  };

  if (process.env.UPDATE_MCP_TOOLS_LIST === '1') {
    fs.writeFileSync(FIXTURE, `${JSON.stringify(current, null, 2)}\n`);
  }
  const pinned = JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as typeof current;

  it('advertises the same tools, descriptions and schemas to an operator', () => {
    expect(current.operator).toEqual(pinned.operator);
  });

  it('advertises the same tools, descriptions and schemas to a guest', () => {
    expect(current.guest).toEqual(pinned.guest);
  });

  it('keeps the list order of the registry', () => {
    expect(Object.keys(current.operator)).toEqual(Object.keys(pinned.operator));
    expect(Object.keys(current.guest)).toEqual(Object.keys(pinned.guest));
  });
});
