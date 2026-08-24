import { IAM_TOOLS } from './iam.tools';
import {
  McpToolContext,
  ToolDef,
  runTool,
  toolInputSchema,
} from './mcp-tool.util';
import { MCP_SCOPE } from '../constants/mcp-scopes';

/**
 * The access tools, and the one thing an agent can do here that it cannot undo
 * by trying again: tell somebody the wrong story about what they just lost.
 *
 * Requirement 42 says a person must be told what a change takes away from them.
 * The arithmetic for that exists once, in `AccessDeltaService`, and both write
 * routes answer with it. What is worth testing on this surface is therefore not
 * the arithmetic — it is that the tool *carries* it and does not quietly
 * substitute its own.
 */
const find = (name: string): ToolDef => {
  const tool = IAM_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
};

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

function ctxFor(calls: Call[], reply: unknown): McpToolContext {
  const send = (method: string, path: string, body?: unknown) => {
    calls.push({ method, path, body });
    return Promise.resolve(reply) as Promise<never>;
  };
  return {
    user: { userId: 'u1', email: 'agent@flui.cloud' },
    scopes: new Set<string>(Object.values(MCP_SCOPE)),
    allowDestructive: true,
    surface: 'mcp',
    audit: { record: jest.fn().mockResolvedValue(undefined) },
    api: {
      get: (path: string) => send('GET', path),
      post: (path: string, body?: unknown) => send('POST', path, body),
      put: (path: string, body?: unknown) => send('PUT', path, body),
      patch: (path: string, body?: unknown) => send('PATCH', path, body),
      delete: (path: string) => send('DELETE', path),
    },
  } as unknown as McpToolContext;
}

async function seenBy(
  name: string,
  args: Record<string, unknown>,
  reply: unknown,
): Promise<{ calls: Call[]; model: Record<string, unknown> }> {
  const calls: Call[] = [];
  const result = await runTool(ctxFor(calls, reply), find(name), args);
  if (result.isError) throw new Error(result.content[0].text);
  return { calls, model: JSON.parse(result.content[0].text) };
}

/** The shape `POST`/`DELETE /iam/grants` answer with, delta and all. */
const REMOVED = {
  id: 'g-7',
  principalType: 'user',
  principalRef: 'bob@acme.com',
  role: 'maintainer',
  scopeType: 'cluster',
  scopeRef: 'c-1',
  selector: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  delta: {
    principal: { type: 'user', ref: 'bob@acme.com' },
    summary: 'Bob loses two applications and the Clusters section.',
    coverage: 'snapshot',
    losesNothing: false,
    losesEverything: false,
    principalIsPlatformAdmin: false,
    sectionsClosed: [{ key: 'clusters' }],
    sectionsDowngraded: [],
    applicationsLost: [{ slug: 'billing-api', clusterName: 'prod' }],
    applicationsLostCount: 2,
    permissionsLost: ['app:write'],
  },
};

describe('the access tools', () => {
  describe('what a revocation tells the person it happened to', () => {
    it('carries the API’s own sentence rather than a summary of its own', async () => {
      const { model } = await seenBy(
        'access_grant_remove',
        { grantId: 'g-7' },
        REMOVED,
      );
      const impact = model.impact as Record<string, unknown>;
      expect(impact.summary).toBe(REMOVED.delta.summary);
      expect(impact.sectionsClosed).toEqual(['clusters']);
      expect(impact.permissionsLost).toEqual(['app:write']);
    });

    /**
     * The count and the list disagree on purpose — two applications lost, one
     * named — and the model has to be told both, or it reports the shorter
     * number as the whole loss.
     */
    it('never lets the named list be mistaken for the whole loss', async () => {
      const { model } = await seenBy(
        'access_grant_remove',
        { grantId: 'g-7' },
        REMOVED,
      );
      const apps = (model.impact as { applications: Record<string, unknown> })
        .applications;
      expect(apps.count).toBe(2);
      expect(apps.named).toEqual(['billing-api (prod)']);
      expect(apps.andMore).toBe(1);
      expect(String(apps.completeness)).toContain('TODAY');
    });

    /**
     * The one reading that must never collapse into "nothing was lost": an
     * inventory that could not be read.
     */
    it('says the applications are unknown rather than none', async () => {
      const { model } = await seenBy(
        'access_grant_remove',
        { grantId: 'g-7' },
        {
          ...REMOVED,
          delta: {
            ...REMOVED.delta,
            coverage: 'unknown',
            applicationsLost: [],
            applicationsLostCount: 0,
          },
        },
      );
      const apps = (model.impact as { applications: unknown }).applications;
      expect(typeof apps).toBe('string');
      expect(String(apps)).toContain(
        'do NOT tell the person nothing will be lost',
      );
    });

    it('leaves the impact out entirely when the API sent none, instead of inventing an empty one', async () => {
      const { model } = await seenBy(
        'access_grant_remove',
        { grantId: 'g-7' },
        { ...REMOVED, delta: undefined },
      );
      expect(model.impact).toBeUndefined();
    });
  });

  describe('conferring', () => {
    it('sends the request the route validates, unchanged', async () => {
      const args = {
        principalType: 'user',
        principalRef: 'bob@acme.com',
        role: 'viewer',
        scopeType: 'selector',
        selector: { owner: 'u-9' },
      };
      const { calls } = await seenBy('access_grant_add', args, REMOVED);
      expect(calls).toEqual([
        { method: 'POST', path: '/iam/grants', body: args },
      ]);
    });

    it('reports what the new grant changed for the person who got it', async () => {
      const { model } = await seenBy(
        'access_grant_add',
        {
          principalType: 'group',
          principalRef: 'platform',
          role: 'operator',
          scopeType: 'global',
        },
        { ...REMOVED, delta: { ...REMOVED.delta, losesNothing: true } },
      );
      expect(model.grantId).toBe('g-7');
      expect((model.impact as { onlyAdds: boolean }).onlyAdds).toBe(true);
    });

    /**
     * `sandbox` and `showcase_viewer` are tenancies the platform writes for
     * itself, and the grant DTO has always refused them. The tool's schema has
     * to refuse them too, one layer earlier: a model handed a free-text `role`
     * invents plausible ones, and a round trip spent on a 400 is a round trip
     * the agent spends guessing again.
     */
    it('refuses a role this installation does not assign, before any call is made', () => {
      const schema = toolInputSchema(find('access_grant_add').inputSchema);
      const base = {
        principalType: 'user',
        principalRef: 'bob@acme.com',
        scopeType: 'global',
      };
      expect(schema.safeParse({ ...base, role: 'sandbox' }).success).toBe(
        false,
      );
      expect(schema.safeParse({ ...base, role: 'admin' }).success).toBe(false);
      expect(schema.safeParse({ ...base, role: 'owner' }).success).toBe(true);
    });
  });

  describe('finding the grant in the first place', () => {
    it('lists them with the id the other two tools take', async () => {
      const { calls, model } = await seenBy('access_grant_list', {}, [REMOVED]);
      expect(calls).toEqual([
        { method: 'GET', path: '/iam/grants', body: undefined },
      ]);
      expect(model).toEqual([
        {
          grantId: 'g-7',
          principal: 'user:bob@acme.com',
          role: 'maintainer',
          reaches: 'cluster c-1',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
    });

    it('shows a standing rule as the predicate it is, not as a place', async () => {
      const { model } = await seenBy('access_grant_list', {}, [
        {
          ...REMOVED,
          scopeType: 'selector',
          scopeRef: null,
          selector: { owner: 'u-9' },
        },
      ]);
      expect((model as unknown as { reaches: unknown }[])[0].reaches).toEqual({
        selector: { owner: 'u-9' },
      });
    });
  });

  describe('the split between looking and changing', () => {
    it('keeps every read on mcp:iam:read and every write on mcp:iam:write', () => {
      const byName = Object.fromEntries(
        IAM_TOOLS.map((t) => [t.name, t.scope]),
      );
      expect(byName).toEqual({
        access_revocation_preview: MCP_SCOPE.IAM_READ,
        access_grant_list: MCP_SCOPE.IAM_READ,
        access_grant_add: MCP_SCOPE.IAM_WRITE,
        access_grant_remove: MCP_SCOPE.IAM_WRITE,
      });
    });
  });
});
