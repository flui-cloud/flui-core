import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { INFRASTRUCTURE_OPERATION_TOOLS } from './infrastructure-operations.tools';
import { ALL_TOOLS } from './tool-registry';
import {
  McpToolContext,
  ToolDef,
  isExecutable,
  runTool,
} from './mcp-tool.util';
import { MCP_SCOPE, SCOPE_TIER } from '../constants/mcp-scopes';
import { McpApiCaller, McpApiError } from '../services/mcp-api.client';
import { isOfferedToGuest } from '../services/sandbox-tool-visibility';
import { McpScopeResolver } from '../services/mcp-scope.resolver';
import { isInputRequired } from '../protocol/mrtr';
import { ACTION_PROPOSAL_CODE } from '../../action-cycle/action-cycle.core';
import { SCOPE_AUTHORITY } from '../../auth/constants/api-key-scopes';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

/**
 * The one property this whole round exists to have: **the pause is on the
 * route, and every tool that writes here goes to a route that has it.**
 *
 * The failure it guards against is the one the plan named as still live —
 * putting the action cycle in the panel instead of in the operations. A tool
 * shipped against an undecorated route is not a slightly weaker version of this
 * feature: it is an agent that stops somebody's cluster without anybody being
 * asked, which is worse than no tool at all. So the decorations are read out of
 * the controller sources, the way the route sentinel reads permissions, and
 * compared against what the tools declare.
 */

const MODULES = join(__dirname, '..', '..');

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...controllerFiles(full));
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

interface Declared {
  action: string;
  estimate?: string;
  consequence?: string;
  bound: boolean;
}

/**
 * Every `@ActionCycle` in the tree, read as text.
 *
 * Text and not metadata: importing the controllers would drag half the
 * application in, and the question here is what is *written* on the handler.
 */
function actionCycleDeclarations(): Map<string, Declared> {
  const found = new Map<string, Declared>();
  for (const file of controllerFiles(MODULES)) {
    const source = readFileSync(file, 'utf8');
    let at = source.indexOf('@ActionCycle({');
    while (at >= 0) {
      const end = source.indexOf('\n  })', at);
      const block = source.slice(at, end < 0 ? source.length : end);
      const action = /action:\s*\n?\s*'([^']+)'/.exec(block)?.[1];
      if (action) {
        found.set(action, {
          action,
          estimate: /\n\s*estimate:\s*'([^']+)'/.exec(block)?.[1],
          consequence: /consequence:\s*\n?\s*'([^']+)'/.exec(block)?.[1],
          bound: /bind:\s*\[/.test(block),
        });
      }
      at = source.indexOf('@ActionCycle({', at + 1);
    }
  }
  return found;
}

const CYCLED = actionCycleDeclarations();

const WRITE_SCOPES: string[] = [
  MCP_SCOPE.INFRA_WRITE,
  MCP_SCOPE.INFRA_DESTRUCTIVE,
];

/**
 * Read off the whole registry rather than off this file, because the area is
 * what has the property and the area no longer lives in one file: the scaling
 * group is operated from `scaling.tools.ts` on the same two scopes. Filtering
 * by the file would have let a machine-room write ship against an undecorated
 * route simply by being declared next door — which is the exact failure the
 * second assertion below exists to catch.
 */
const writes = ALL_TOOLS.filter((t) => WRITE_SCOPES.includes(t.scope));
const reads = ALL_TOOLS.filter((t) => t.scope === MCP_SCOPE.INFRA_READ);

describe('operating the infrastructure — the pause is on the route', () => {
  it('sends every write to a route that declares the action cycle', () => {
    const undeclared: string[] = [];
    for (const tool of writes) {
      for (const route of tool.routes ?? []) {
        if (!CYCLED.has(route)) undeclared.push(`${tool.name} → ${route}`);
      }
    }
    expect(undeclared.sort()).toEqual([]);
  });

  /**
   * The mirror of the assertion above, and the one that catches the drift the
   * other cannot see: a tool that quietly stopped declaring the route it calls
   * would satisfy the first test with an empty list.
   */
  it('has a write tool for each of them, so none is a decoration over nothing', () => {
    const declaredByTools = new Set(writes.flatMap((t) => t.routes ?? []));
    const mine = [...CYCLED.keys()].filter(
      (a) =>
        a.includes('/infrastructure/clusters') ||
        a.includes('/dns-zone/configure-issuer') ||
        a.includes('/san-certificates') ||
        a.includes('/firewalls/cluster') ||
        a.includes('/mail/domains'),
    );
    expect(mine.filter((a) => !declaredByTools.has(a)).sort()).toEqual([]);
  });

  it('leaves the reads outside it — an estimate that asked permission is useless', () => {
    for (const tool of reads) {
      for (const route of tool.routes ?? []) {
        expect({ tool: tool.name, cycled: CYCLED.has(route) }).toEqual({
          tool: tool.name,
          cycled: false,
        });
      }
    }
  });

  /**
   * Nothing in this file may look like a second gate. A tool holding its own
   * confirmation flag is the shape that lets the same credential skip the
   * control by calling the route directly, and it is also how two disagreeing
   * answers to "may I" come to exist.
   */
  it('re-implements no part of the cycle in the tool', () => {
    for (const tool of INFRASTRUCTURE_OPERATION_TOOLS) {
      // One key at a time, not `not.arrayContaining([...])`: that matcher only
      // fails when EVERY listed key is present, so a single `confirm` argument
      // slipped past it. Found by reversing the change rather than by reading
      // it.
      const args = Object.keys(tool.inputSchema);
      for (const forbidden of [
        'confirm',
        'confirmed',
        'approve',
        'approved',
        'force',
        'proposalId',
      ]) {
        expect({
          tool: tool.name,
          forbidden,
          present: args.includes(forbidden),
        }).toEqual({ tool: tool.name, forbidden, present: false });
      }
      const body = tool.run.toString();
      expect(body).not.toContain('PROPOSAL');
      expect(body).not.toContain('proposal');
    }
  });
});

describe('what the person is asked, and with what attached', () => {
  const estimateOf = (action: string) => CYCLED.get(action)?.estimate;

  /**
   * The plan's rule made checkable: where a price already exists, the proposal
   * carries it. Each pair is a decoration naming a GET and a read tool
   * publishing that same GET, so the agent can also state the number before it
   * even asks.
   */
  it.each([
    [
      'POST /infrastructure/clusters/:id/workers',
      '/infrastructure/clusters/:id/capacity-plan',
      'cluster_capacity_plan',
    ],
    [
      'DELETE /infrastructure/clusters/:id/workers/:nodeId',
      '/infrastructure/clusters/:id/capacity-plan',
      'cluster_capacity_plan',
    ],
    [
      'PATCH /infrastructure/clusters/:id/autoscale',
      '/infrastructure/clusters/:id/capacity-plan',
      'cluster_capacity_plan',
    ],
    [
      'POST /infrastructure/clusters/:id/nodes/:nodeId/scale',
      '/infrastructure/clusters/:id/nodes/:nodeId/scale/preview',
      'cluster_node_scale_preview',
    ],
  ])('prices %s with %s', (action, estimate, tool) => {
    expect(estimateOf(action)).toBe(estimate);
    const published = ALL_TOOLS.find((t) => t.name === tool);
    expect(published?.routes).toContain(`GET ${estimate}`);
  });

  /**
   * `GET .../storage` returns the shared layer's configuration and runtime
   * status and no figure at all, so it cannot back a price on the expand
   * action. Asserted here so the pairing is not quietly restored.
   */
  it('does not pretend the storage status is a price', () => {
    expect(
      estimateOf('POST /infrastructure/clusters/:id/storage/expand'),
    ).toBeUndefined();
    expect(
      CYCLED.get('POST /infrastructure/clusters/:id/storage/expand')
        ?.consequence,
    ).toBeTruthy();
  });

  /**
   * Creating a cluster names no resource, so it cannot state its own edge and
   * is only ever offered "allow once". That is the mockup's rule, and here it
   * is the difference between approving one cluster and approving a standing
   * permission to spend.
   */
  it('offers no standing permission for creating a cluster', () => {
    expect(CYCLED.get('POST /infrastructure/clusters')?.bound).toBe(false);
  });

  it('binds every other one to the resource it acts on', () => {
    const unbound = writes
      .flatMap((t) => t.routes ?? [])
      .filter((a) => a !== 'POST /infrastructure/clusters')
      .filter((a) => !CYCLED.get(a)?.bound);
    expect(unbound.sort()).toEqual([]);
  });
});

describe('the destructive flag, and the line that is not crossed', () => {
  it('marks removing a node destructive and nothing else', () => {
    const destructive = INFRASTRUCTURE_OPERATION_TOOLS.filter(
      (t) => SCOPE_TIER[t.scope] === 'destructive',
    ).map((t) => t.name);
    expect(destructive).toEqual(['cluster_node_remove']);
  });

  it('hides it while the server-wide flag is off, and shows it once it is on', () => {
    const tool = INFRASTRUCTURE_OPERATION_TOOLS.find(
      (t) => t.name === 'cluster_node_remove',
    )!;
    const ctx = (allowDestructive: boolean): McpToolContext =>
      ({
        scopes: new Set<string>(Object.values(MCP_SCOPE)),
        allowDestructive,
      }) as unknown as McpToolContext;
    expect(isExecutable(ctx(false), tool)).toBe(false);
    expect(isExecutable(ctx(true), tool)).toBe(true);
  });

  /**
   * Destroying a cluster is not here, and this says why rather than leaving the
   * absence to be read as an oversight: no agent scope carries
   * `cluster:destroy`, so a tool for it would be refused to every scoped
   * credential. Widening that is a decision for `api-key-scopes.ts` and the
   * route sentinel, not a tool to add in this file.
   */
  it('publishes no tool that deletes a cluster', () => {
    const routes = INFRASTRUCTURE_OPERATION_TOOLS.flatMap(
      (t) => t.routes ?? [],
    );
    expect(routes).not.toContain('DELETE /infrastructure/clusters/:id');
    for (const scope of WRITE_SCOPES) {
      expect(
        SCOPE_AUTHORITY[scope as keyof typeof SCOPE_AUTHORITY].allows,
      ).not.toContain(IAM_PERMISSION.CLUSTER_DESTROY);
    }
  });
});

describe('who is offered these at all', () => {
  it('offers no machine-room write to a sandbox guest', () => {
    for (const tool of writes) {
      expect({ tool: tool.name, offered: isOfferedToGuest(tool) }).toEqual({
        tool: tool.name,
        offered: false,
      });
    }
  });

  /**
   * One read the fence does answer a guest for real: the node listing. The
   * filter says so honestly, and the guest still never sees the tool — its
   * default scopes are the `apps:change` group, which carries no
   * `mcp:infra:read`, and the factory applies both filters. Written down
   * because the two answers look contradictory until you know which one is
   * doing the work.
   */
  it('keeps the one guest-visible read out of a guest toolbox by scope', () => {
    const nodes = reads.find((t) => t.name === 'cluster_node_list')!;
    expect(isOfferedToGuest(nodes)).toBe(true);
    const guest = new McpScopeResolver().resolve(
      { userId: 'g1', email: 'g@x' } as never,
      true,
    );
    expect(guest.has(MCP_SCOPE.INFRA_READ)).toBe(false);
    expect(
      isExecutable(
        { scopes: guest, allowDestructive: true } as unknown as McpToolContext,
        nodes,
      ),
    ).toBe(false);
  });

  /**
   * The machine room is not reachable by silence. `expandTier` is what a
   * principal gets when its credential declares no ceiling, so a scope named in
   * a tier arrives without anybody choosing it — the shape `mcp:iam:write`
   * already refuses.
   */
  it('is carried by no tier, so an unscoped key never acquires it', () => {
    const { TIER_SCOPES, expandTier, DEFAULT_SCOPES } = jest.requireActual<
      typeof import('../constants/mcp-scopes')
    >('../constants/mcp-scopes');
    for (const tier of ['read', 'plan', 'write', 'destructive'] as const) {
      for (const scope of [MCP_SCOPE.INFRA_READ, ...WRITE_SCOPES]) {
        expect({
          tier,
          scope,
          in: (TIER_SCOPES[tier] as string[]).includes(scope),
        }).toEqual({ tier, scope, in: false });
        expect(expandTier(tier) as string[]).not.toContain(scope);
      }
    }
    expect(DEFAULT_SCOPES as string[]).not.toContain(MCP_SCOPE.INFRA_WRITE);
  });
});

describe('a pending request on a machine-room call', () => {
  const ctx = (calls: string[]): McpToolContext => {
    const api: McpApiCaller = {
      get: (path: string) => {
        calls.push(`GET ${path}`);
        return Promise.resolve([{ id: 'c1', name: 'one' }]) as Promise<never>;
      },
      post: (path: string) =>
        Promise.reject(
          new McpApiError(
            403,
            'This call needs a person to allow it first.',
            'POST',
            path,
            ACTION_PROPOSAL_CODE,
            undefined,
            {
              proposalId: 'p-9',
              action: 'POST /infrastructure/clusters/:id/workers',
              sentence: 'add worker nodes to cluster c1',
              offersAlways: true,
              decideUrl: 'https://console.test/agents/requests/p-9',
              estimateWithheld: true,
            },
          ),
        ) as Promise<never>,
      put: () => Promise.reject(new Error('unused')) as Promise<never>,
      patch: () => Promise.reject(new Error('unused')) as Promise<never>,
      delete: () => Promise.reject(new Error('unused')) as Promise<never>,
    };
    return {
      user: { userId: 'u1', email: 'e@x' },
      scopes: new Set<string>(Object.values(MCP_SCOPE)),
      allowDestructive: true,
      surface: 'mcp',
      audit: { record: jest.fn() },
      api,
    } as unknown as McpToolContext;
  };

  const tool = INFRASTRUCTURE_OPERATION_TOOLS.find(
    (t) => t.name === 'cluster_node_add',
  ) as ToolDef;

  it('comes back as a wait pointing at the page, not as a failure', async () => {
    const calls: string[] = [];
    const result = await runTool(ctx(calls), tool, { count: 1 });

    expect(isInputRequired(result)).toBe(true);
    expect((result as { isError?: boolean }).isError).toBeUndefined();
    const requests = (
      result as unknown as {
        inputRequests: Record<string, { params: { url: string } }>;
      }
    ).inputRequests;
    expect(requests.approved.params.url).toBe(
      'https://console.test/agents/requests/p-9',
    );
  });

  it('changed nothing on the way — the wait is the whole outcome', async () => {
    const calls: string[] = [];
    await runTool(ctx(calls), tool, { count: 1 });
    // Resolving the sole cluster is the only thing it managed to do.
    expect(calls).toEqual(['GET /infrastructure/clusters']);
  });
});
