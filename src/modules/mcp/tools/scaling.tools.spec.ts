import { SCALING_TOOLS } from './scaling.tools';
import { McpToolContext, ToolDef, runTool } from './mcp-tool.util';
import { McpApiCaller } from '../services/mcp-api.client';
import { MCP_SCOPE, SCOPE_TIER } from '../constants/mcp-scopes';
import { isOfferedToGuest } from '../services/sandbox-tool-visibility';
import {
  scalingConsequenceClause,
  scalingConsequenceOf,
} from '../../infrastructure/scaling/scaling-consequence';

/**
 * What these tools have to get right is not plumbing. It is the set of
 * meanings a wrong description would teach a model for good: the three bounds
 * are three roles, a decline is an answer, a null price is not zero, and where
 * nothing can be provisioned the agent's whole contribution is the warning.
 */

interface Recorded {
  method: string;
  path: string;
  body?: unknown;
}

const GROUP = {
  id: 'g1',
  name: 'general',
  clusterId: 'c1',
  clusterName: 'prod',
  provider: 'hetzner',
  capability: {
    provider: 'hetzner',
    canProvision: true,
    hasCatalogue: true,
    billing: 'hourly',
  },
  bounds: { min: 1, desired: 3, max: 5 },
  regions: ['fsn1'],
  shapes: ['cx22', 'cx32'],
  strategy: 'cheapest',
  settleSeconds: 30,
  limits: { hourlyBillingOnly: true, maxMonthlyCost: 40 },
  provision: 'automatic' as const,
  acts: {
    acts: true,
    says: 'This installation may commit up to €200 a month on its own, and only through groups set to buy automatically.',
    monthlyEur: 200,
  },
  standingOrders: [],
  requirement: null,
};

/** The same group on an installation that granted nothing: automatic and inert. */
const UNGRANTED = {
  ...GROUP,
  acts: {
    acts: false,
    says: 'Nothing may be bought without being asked: no spending was granted to this installation.',
    monthlyEur: null,
  },
};

const CONTABO = {
  ...GROUP,
  provider: 'contabo',
  capability: {
    provider: 'contabo',
    canProvision: false,
    hasCatalogue: true,
    billing: 'monthly',
  },
  provision: 'manual' as const,
};

const BYOS = {
  ...GROUP,
  provider: 'byos',
  capability: {
    provider: 'byos',
    canProvision: false,
    hasCatalogue: false,
    billing: 'none',
  },
  provision: 'manual' as const,
  regions: [],
  shapes: [],
  limits: { hourlyBillingOnly: false, maxMonthlyCost: null },
  requirement: { cpu: '2', memory: '8Gi' },
};

function ctxFor(
  calls: Recorded[],
  reply: (r: Recorded) => unknown,
): McpToolContext {
  const send = (method: string, path: string, body?: unknown) => {
    const call = { method, path, body };
    calls.push(call);
    return Promise.resolve(reply(call)) as Promise<never>;
  };
  const api: McpApiCaller = {
    get: (path) => send('GET', path),
    post: (path, body) => send('POST', path, body),
    put: (path, body) => send('PUT', path, body),
    patch: (path, body) => send('PATCH', path, body),
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
  const tool = SCALING_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not found`);
  return tool;
};

async function call(
  name: string,
  args: Record<string, unknown>,
  reply: (r: Recorded) => unknown,
): Promise<{ calls: Recorded[]; data: Record<string, unknown>; raw: string }> {
  const calls: Recorded[] = [];
  const result = await runTool(ctxFor(calls, reply), find(name), args);
  const raw = (result as { content: Array<{ text: string }> }).content[0].text;
  const isError = (result as { isError?: boolean }).isError === true;
  return {
    calls,
    data: isError ? {} : (JSON.parse(raw) as Record<string, unknown>),
    raw,
  };
}

describe('the scaling tools are scoped where the machine room is', () => {
  it('reads on mcp:infra:read and reads at the read tier', () => {
    for (const name of [
      'scaling_group_get',
      'scaling_overview',
      'scaling_why',
    ]) {
      const tool = find(name);
      expect({ name, scope: tool.scope, tier: SCOPE_TIER[tool.scope] }).toEqual(
        {
          name,
          scope: MCP_SCOPE.INFRA_READ,
          tier: 'read',
        },
      );
    }
  });

  /**
   * The tier is derived from the scope, so a careless scope is how a read gets
   * filed as a write — and how a write gets filed as a read, which is the
   * expensive direction.
   */
  it('writes on mcp:infra:write and at the write tier', () => {
    const tool = find('scaling_group_set');
    expect(tool.scope).toBe(MCP_SCOPE.INFRA_WRITE);
    expect(SCOPE_TIER[tool.scope]).toBe('write');
  });

  /** No `mcp:infra:*` scope is in any tier, so none arrives by omission. */
  it('offers nothing here to a sandbox guest', () => {
    for (const tool of SCALING_TOOLS) {
      expect({ name: tool.name, guest: isOfferedToGuest(tool) }).toEqual({
        name: tool.name,
        guest: false,
      });
    }
  });
});

describe('scaling_group_get', () => {
  it('reads one group by id without listing anything first', async () => {
    const { calls, data } = await call(
      'scaling_group_get',
      { groupId: 'g1' },
      () => GROUP,
    );
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /infrastructure/scaling-groups/g1',
    ]);
    expect(data.count).toBe(1);
  });

  it('names the three bounds by the role each one plays', async () => {
    const { data } = await call(
      'scaling_group_get',
      { groupId: 'g1' },
      () => GROUP,
    );
    const group = (data.groups as Array<Record<string, unknown>>)[0];
    expect(group.bounds).toEqual({
      floorHeldNow: 1,
      targetApproachedWhenTheMarketAllows: 3,
      ceilingUrgencyMayReachNow: 5,
    });
  });

  it('says what a cluster with no group means, rather than answering with nothing', async () => {
    const { data } = await call('scaling_group_get', {}, (r) =>
      r.path === '/infrastructure/clusters' ? [{ id: 'c1', name: 'prod' }] : [],
    );
    expect(data.count).toBe(0);
    expect(String(data.note)).toContain('raise an alarm');
  });

  it('falls back to the sole cluster instead of demanding an id', async () => {
    const { calls } = await call('scaling_group_get', {}, (r) =>
      r.path === '/infrastructure/clusters' ? [{ id: 'c1', name: 'prod' }] : [],
    );
    expect(calls[calls.length - 1].path).toBe(
      '/infrastructure/clusters/c1/scaling-groups',
    );
  });
});

/**
 * The group says how large and how expensive it may become; the installation
 * says how much may be committed with nobody in the room. A surface carrying
 * only the first is a surface that says a group is armed when it buys nothing,
 * and idle when it spends.
 */
describe('the second key — what the installation granted', () => {
  const viewOf = async (group: unknown): Promise<Record<string, unknown>> => {
    const { data } = await call(
      'scaling_group_get',
      { groupId: 'g1' },
      () => group,
    );
    return (data.groups as Array<Record<string, unknown>>)[0];
  };

  it('answers “would this group do anything” beside what it is configured as', async () => {
    const view = await viewOf(GROUP);
    expect(view.provision).toBe('automatic');
    expect(view.acts).toEqual(GROUP.acts);
  });

  it('carries the installation’s own sentence rather than rewording it', async () => {
    const view = await viewOf(GROUP);
    expect((view.acts as Record<string, unknown>).says).toBe(GROUP.acts.says);
    expect(String(view.authorises)).toContain(GROUP.acts.says);
  });

  /** Automatic and granted nothing is the case that looks armed and is not. */
  it('says an automatic group with no grant reaches no provider at all', async () => {
    const view = await viewOf(UNGRANTED);
    expect(view.provision).toBe('automatic');
    expect((view.acts as Record<string, unknown>).acts).toBe(false);
    expect(String(view.actsMeans)).toContain('NOTHING this group decides');
    expect(String(view.authorises)).toContain('none of it reaches a provider');
  });

  it('never turns “no grant” into a grant of zero', async () => {
    const view = await viewOf(UNGRANTED);
    expect((view.acts as Record<string, unknown>).monthlyEur).toBeNull();
    expect(String(view.actsMeans)).not.toContain('€0');
  });

  /** The figure is the grant's, never one written down in the tool. */
  it('quotes the grant it was given and no figure of its own', async () => {
    const richer = {
      ...GROUP,
      acts: { ...GROUP.acts, monthlyEur: 750, says: 'granted €750 a month' },
    };
    expect(String((await viewOf(richer)).actsMeans)).toContain('€750');
    expect(String((await viewOf(GROUP)).actsMeans)).toContain('€200');
  });

  /** An installation one build behind said nothing, which is not an answer. */
  it('refuses to read a missing answer as either answer', async () => {
    const { acts, ...older } = GROUP;
    expect(acts).toBeDefined();
    const view = await viewOf(older);
    expect(view.acts).toBeNull();
    expect(String(view.actsMeans)).toContain('Do not assume either way');
  });
});

/**
 * A replacement buys a machine and then drains the one it stands in for. If the
 * drain cannot happen, the group waits for a purchase that never comes — and
 * nothing else on any surface tells that apart from patience.
 */
describe('a standing order whose node cannot be emptied', () => {
  const BLOCKED = {
    ...GROUP,
    standingOrders: [
      {
        kind: 'replace',
        shape: 'cx32',
        region: 'fsn1',
        wanted: 1,
        replaces: 'worker-3',
        drainable: {
          ok: false,
          blockers: [
            {
              kind: 'bound-volume',
              what: 'flui-apps/postgres-0 → data',
              fix: 'The volume lives on this machine and does not follow the pod.',
            },
          ],
          cleared: [],
        },
      },
    ],
  };

  const ordersOf = async (group: unknown) => {
    const { data } = await call(
      'scaling_group_get',
      { groupId: 'g1' },
      () => group,
    );
    const view = (data.groups as Array<Record<string, unknown>>)[0];
    return view.standingOrders as Array<Record<string, unknown>>;
  };

  it('names what blocks and what would have to change, never just a flag', async () => {
    const [order] = await ordersOf(BLOCKED);
    expect(order.drainable).toEqual(BLOCKED.standingOrders[0].drainable);
    expect(String(order.drainableMeans)).toContain('HELD BACK');
    expect(String(order.drainableMeans)).toContain('never proceed');
  });

  it('reads an unanswered drain as no answer rather than as a yes', async () => {
    const [order] = await ordersOf({
      ...BLOCKED,
      standingOrders: [{ ...BLOCKED.standingOrders[0], drainable: null }],
    });
    expect(String(order.drainableMeans)).toContain('NOT ANSWERED');
    expect(String(order.drainableMeans)).toContain('not a yes');
  });

  /** An expansion drains nothing, so an unanswered check would be a lie. */
  it('asks nothing about the drain of an expansion', async () => {
    const [order] = await ordersOf({
      ...GROUP,
      standingOrders: [
        {
          kind: 'expand',
          shape: 'cx32',
          region: 'fsn1',
          wanted: 1,
          replaces: null,
          drainable: null,
        },
      ],
    });
    expect(order).not.toHaveProperty('drainable');
    expect(order).not.toHaveProperty('drainableMeans');
  });
});

describe('the provider asymmetry reaches the model', () => {
  const meansOf = async (group: unknown): Promise<string> => {
    const { data } = await call(
      'scaling_group_get',
      { groupId: 'g1' },
      () => group,
    );
    const first = (data.groups as Array<Record<string, unknown>>)[0];
    return String((first.capability as Record<string, unknown>).means);
  };

  it('lets an agent buy only where the provider declares it can', async () => {
    expect(await meansOf(GROUP)).toContain('can buy servers');
    const { data } = await call(
      'scaling_group_get',
      { groupId: 'g1' },
      () => GROUP,
    );
    const first = (data.groups as Array<Record<string, unknown>>)[0];
    expect((first.capability as Record<string, unknown>).agentMay).toBe('buy');
  });

  it('tells it to warn, not to scale, where there is a catalogue and no create API', async () => {
    const means = await meansOf(CONTABO);
    expect(means).toContain('CANNOT buy');
    expect(means).toContain('naming a shape and its price');
    const { data } = await call(
      'scaling_group_get',
      { groupId: 'g1' },
      () => CONTABO,
    );
    const first = (data.groups as Array<Record<string, unknown>>)[0];
    expect((first.capability as Record<string, unknown>).agentMay).toBe('warn');
  });

  /** No catalogue, and there never will be one — so no shape may even be named. */
  it('forbids naming a shape at all where nothing publishes one', async () => {
    const means = await meansOf(BYOS);
    expect(means).toContain('no catalogue');
    expect(means).toContain('what a machine has to hold');
  });

  it('reads the difference off the flags and never off the provider name', () => {
    const named = { ...CONTABO.capability, provider: 'hetzner' };
    expect(scalingConsequenceOf({ ...CONTABO, capability: named })).toContain(
      'Flui buys none of them here',
    );
  });
});

describe('scaling_overview', () => {
  const ROWS = [
    {
      clusterId: 'c1',
      clusterName: 'prod',
      capability: GROUP.capability,
      groupId: 'g1',
      groupCount: 2,
      groups: [
        {
          id: 'g1',
          name: 'general',
          provision: 'automatic',
          bounds: GROUP.bounds,
        },
        {
          id: 'g2',
          name: 'heavy',
          provision: 'manual',
          bounds: { min: 0, desired: 0, max: 0 },
        },
      ],
      bounds: GROUP.bounds,
      nodes: 3,
      monthlyEur: 48,
      unpricedNodes: 1,
      monthlyCap: 40,
      pendingPods: 0,
      openOrders: 0,
      blockedOrders: 0,
      openAlarm: null,
      lastDecisionAt: null,
      needsPerson: null,
    },
    {
      clusterId: 'c2',
      clusterName: 'byos-one',
      capability: BYOS.capability,
      groupId: null,
      groupCount: 0,
      groups: [],
      bounds: null,
      nodes: 1,
      monthlyEur: null,
      unpricedNodes: 1,
      monthlyCap: null,
      // No group of this cluster could get an answer, which is not calm.
      pendingPods: null,
      openOrders: 0,
      blockedOrders: 2,
      openAlarm: null,
      lastDecisionAt: null,
      needsPerson: 'No scaling group.',
    },
  ];

  it('asks for every cluster when none is named', async () => {
    const { calls } = await call('scaling_overview', {}, () => ROWS);
    expect(calls).toEqual([{ method: 'GET', path: '/infrastructure/scaling' }]);
  });

  it('keeps the clusters that have no group, and counts them', async () => {
    const { data } = await call('scaling_overview', {}, () => ROWS);
    expect(data.count).toBe(2);
    expect(data.clustersWithoutAGroup).toBe(1);
    expect(data.clustersThatCanOnlyWarn).toBe(1);
    expect(data.needAPerson).toBe(1);
  });

  it('carries a null bill through as null, and says it is not zero', async () => {
    const { data, raw } = await call('scaling_overview', {}, () => ROWS);
    const rows = data.rows as Array<Record<string, unknown>>;
    expect(rows[1].monthlyEur).toBeNull();
    expect(raw).toContain('is NOT zero');
    expect(String((data.notes as string[]).join(' '))).toContain(
      'never add it up',
    );
  });

  /**
   * The one that reads like an answer and is not: a figure summed over half a
   * fleet. Reported bare it says the cluster is cheap, and nobody checks a
   * number that looks complete.
   */
  it('says a partly priced fleet is a floor and not the bill', async () => {
    const { data } = await call('scaling_overview', {}, () => ROWS);
    const rows = data.rows as Array<Record<string, unknown>>;
    expect(rows[0].monthlyEur).toBe(48);
    expect(rows[0].unpricedNodes).toBe(1);
    expect(String(rows[0].monthlyEurMeans)).toContain('FLOOR, not the bill');
  });

  it('keeps “no bill ever” apart from “no price yet”', async () => {
    const { data } = await call('scaling_overview', {}, () => ROWS);
    const rows = data.rows as Array<Record<string, unknown>>;
    expect(String(rows[1].monthlyEurMeans)).toContain('never will be');
  });

  /**
   * The reading that is wrong in the direction nobody checks: a cluster that
   * answered nothing, printed as a cluster with nothing waiting.
   */
  it('keeps “nothing waiting” apart from “nobody could ask”', async () => {
    const { data } = await call('scaling_overview', {}, () => ROWS);
    const rows = data.rows as Array<Record<string, unknown>>;
    expect(rows[0].pendingPods).toBe(0);
    expect(String(rows[0].pendingPodsMeans)).toContain('0 pod(s)');

    expect(rows[1].pendingPods).toBeNull();
    expect(String(rows[1].pendingPodsMeans)).toContain('NOT ANSWERED');
    expect(String(rows[1].pendingPodsMeans)).toContain('never as');
  });

  /** A held-back order is a purchase that never happens and never says so. */
  it('says what a blocked standing order is, rather than counting it', async () => {
    const { data } = await call('scaling_overview', {}, () => ROWS);
    const rows = data.rows as Array<Record<string, unknown>>;
    expect(rows[1].blockedOrders).toBe(2);
    expect(String(rows[1].blockedOrdersMeans)).toContain('never proceed');
    expect(String(rows[0].blockedOrdersMeans)).toContain('No standing order');
  });

  // A count leaves a cluster's second group unnamed until somebody fetches
  // again — and the row already carries the names.
  it('names every group of a cluster in the row itself', async () => {
    const { data } = await call('scaling_overview', {}, () => ROWS);
    const rows = data.rows as Array<Record<string, unknown>>;
    expect(rows[0].groups).toEqual([
      {
        groupId: 'g1',
        name: 'general',
        provision: 'automatic',
        ceilingUrgencyMayReachNow: 5,
      },
      {
        groupId: 'g2',
        name: 'heavy',
        provision: 'manual',
        ceilingUrgencyMayReachNow: 0,
      },
    ]);
  });
});

describe('scaling_why — the decline is the answer', () => {
  const DECISIONS = [
    {
      id: 'd1',
      at: '2026-08-27T02:14:00.000Z',
      force: 'urgency',
      outcome: 'declined',
      saw: 'one pod pending for 90s',
      did: 'nothing',
      why: 'every shape that fits is above the €40 monthly ceiling',
      asks: null,
      shape: null,
      region: null,
      hourlyEur: null,
      considered: [
        {
          shape: 'cx32',
          region: 'fsn1',
          hourlyEur: 0.02,
          outcome: 'over-budget',
        },
        {
          shape: 'cx22',
          region: 'fsn1',
          hourlyEur: 0.01,
          outcome: 'refused-by-limit',
        },
      ],
    },
    {
      id: 'd2',
      at: '2026-08-26T02:14:00.000Z',
      force: 'urgency',
      outcome: 'alerted',
      saw: 'one pod pending',
      did: 'raised an alarm',
      why: 'nothing can be bought here',
      asks: 'add a machine with 2 CPU and 8Gi',
      shape: null,
      region: null,
      hourlyEur: null,
      considered: [],
    },
  ];

  const CLUSTER_DECISIONS = [
    { ...DECISIONS[0], groupId: 'g1', groupName: 'general' },
    { ...DECISIONS[1], groupId: 'g2', groupName: 'heavy' },
  ];

  /** The decisions that reached a provider: a machine was bought, one went back. */
  const ACTED = [
    {
      ...DECISIONS[0],
      id: 'd3',
      outcome: 'added',
      did: 'Bought a cx32 in fsn1 and set it to join.',
      why: 'About €62 a month against the €200 granted.',
      shape: 'cx32',
      region: 'fsn1',
      hourlyEur: 0.02,
      considered: [],
    },
    {
      ...DECISIONS[0],
      id: 'd4',
      force: 'opportunity',
      outcome: 'removed',
      did: 'Removed worker-3.',
      why: 'The fleet is above its target and the node can be emptied.',
      considered: [],
    },
  ];

  it('reads the decisions of the group it was given', async () => {
    const { calls } = await call(
      'scaling_why',
      { groupId: 'g1' },
      () => DECISIONS,
    );
    expect(calls).toEqual([
      { method: 'GET', path: '/infrastructure/scaling-groups/g1/decisions' },
    ]);
  });

  /**
   * Nobody asks an autoscaler what is configured; they ask why nothing
   * happened, about a cluster. Reaching that through a group made somebody pick
   * one first — and a model picking one picks wrong, then reports the wrong
   * fleet's reasoning as the cluster's.
   */
  it('asks the cluster when no group is named', async () => {
    const { calls } = await call('scaling_why', {}, (r) =>
      r.path === '/infrastructure/clusters'
        ? [{ id: 'c1', name: 'prod' }]
        : CLUSTER_DECISIONS,
    );
    expect(calls.map((c) => c.path)).toEqual([
      '/infrastructure/clusters',
      '/infrastructure/clusters/c1/scaling-decisions',
    ]);
  });

  it('names the group each decision came from', async () => {
    const { data } = await call(
      'scaling_why',
      { clusterId: 'c1' },
      () => CLUSTER_DECISIONS,
    );
    expect(data.askedOf).toBe('cluster');
    expect(
      (data.decisions as Array<Record<string, unknown>>).map((d) => d.group),
    ).toEqual(['general (g1)', 'heavy (g2)']);
  });

  it('answers for a cluster holding several groups instead of refusing', async () => {
    const { data } = await call(
      'scaling_why',
      { clusterId: 'c1' },
      () => CLUSTER_DECISIONS,
    );
    expect(data.declined).toBe(1);
    expect(data.alerted).toBe(1);
  });

  it('surfaces the declines and the alarms rather than filtering them', async () => {
    const { data } = await call(
      'scaling_why',
      { groupId: 'g1' },
      () => DECISIONS,
    );
    expect(data.declined).toBe(1);
    expect(data.alerted).toBe(1);
    expect(data.acted).toBe(0);
    expect(data.openAsks).toBe(1);
    expect((data.decisions as unknown[]).length).toBe(2);
  });

  /**
   * A decision that reached a provider is news of a different kind: `added` is
   * money committed, `removed` is a node given back. Summed into one figure
   * they read as "something happened", which is the report nobody can act on.
   */
  it('counts what actually reached a provider, and says which was which', async () => {
    const { data } = await call('scaling_why', { groupId: 'g1' }, () => ACTED);
    expect(data.acted).toBe(2);
    expect(data.added).toBe(1);
    expect(data.removed).toBe(1);
    expect(data.replaced).toBe(0);
    expect(data.declined).toBe(0);
  });

  it('hands back the whole of why a machine was bought, not a summary of it', async () => {
    const { data } = await call('scaling_why', { groupId: 'g1' }, () => ACTED);
    const rows = data.decisions as Array<Record<string, unknown>>;
    expect(rows[0].outcome).toBe('added');
    expect(rows[0].why).toBe(ACTED[0].why);
    expect(rows[1].outcome).toBe('removed');
    expect(rows[1].why).toBe(ACTED[1].why);
  });

  /** The refusal names WHICH gate stopped it, and the gates have different fixes. */
  it('tells the model the gate is in `why`, on both sides of the decision', async () => {
    const { data } = await call('scaling_why', { groupId: 'g1' }, () => ACTED);
    const note = String(data.note);
    expect(note).toContain('names the gate that let it through');
    expect(note).toContain('names the gate that stopped it');
    expect(note).toContain('never summarise it as "nothing happened"');
  });

  it('keeps over-budget and refused-by-limit apart', async () => {
    const { data } = await call(
      'scaling_why',
      { groupId: 'g1' },
      () => DECISIONS,
    );
    const first = (data.decisions as Array<Record<string, unknown>>)[0];
    expect(
      (first.considered as Array<{ outcome: string }>).map((c) => c.outcome),
    ).toEqual(['over-budget', 'refused-by-limit']);
  });

  it('keeps the sentence addressed to a person, verbatim', async () => {
    const { data } = await call(
      'scaling_why',
      { groupId: 'g1' },
      () => DECISIONS,
    );
    const alarm = (data.decisions as Array<Record<string, unknown>>)[1];
    expect(alarm.asks).toBe('add a machine with 2 CPU and 8Gi');
    expect(String(data.note)).toContain('nothing here clears one');
  });

  it('refuses to read an empty history as "all is well"', async () => {
    const { data } = await call('scaling_why', { groupId: 'g1' }, () => []);
    expect(String(data.note)).toContain('do not report it as');
  });

  it('says a cluster with no group has decided nothing, and why that matters', async () => {
    const { raw } = await call('scaling_why', {}, (r) =>
      r.path === '/infrastructure/clusters' ? [{ id: 'c1', name: 'prod' }] : [],
    );
    expect(raw).toContain('no scaling group');
    expect(raw).toContain('raise no alarm');
  });

  it('keeps an empty group history apart from an empty cluster', async () => {
    const { data } = await call('scaling_why', { groupId: 'g1' }, () => []);
    expect(data.askedOf).toBe('group');
    expect(String(data.note)).toContain('this group');
  });

  /**
   * An empty answer is two answers, and only the second read tells them apart —
   * so it is bought only when the list came back empty.
   */
  it('asks which groups exist only when nothing was decided', async () => {
    const quiet = await call('scaling_why', { clusterId: 'c1' }, (r) =>
      r.path.endsWith('/scaling-decisions') ? [] : [GROUP],
    );
    expect(quiet.calls.map((c) => c.path)).toEqual([
      '/infrastructure/clusters/c1/scaling-decisions',
      '/infrastructure/clusters/c1/scaling-groups',
    ]);
    expect(String(quiet.data.note)).toContain('any group on this cluster');

    const busy = await call(
      'scaling_why',
      { clusterId: 'c1' },
      () => CLUSTER_DECISIONS,
    );
    expect(busy.calls).toHaveLength(1);
  });
});

describe('scaling_group_set', () => {
  it('patches an existing group and never touches the cluster route', async () => {
    const { calls } = await call(
      'scaling_group_set',
      { groupId: 'g1', bounds: { min: 1, desired: 3, max: 5 } },
      () => GROUP,
    );
    expect(calls).toEqual([
      {
        method: 'PATCH',
        path: '/infrastructure/scaling-groups/g1',
        body: { bounds: { min: 1, desired: 3, max: 5 } },
      },
    ]);
  });

  it('writes a new group against the sole cluster', async () => {
    const { calls } = await call(
      'scaling_group_set',
      { name: 'general', bounds: { min: 1, desired: 3, max: 5 } },
      (r) =>
        r.path === '/infrastructure/clusters'
          ? [{ id: 'c1', name: 'prod' }]
          : GROUP,
    );
    expect(calls[calls.length - 1]).toEqual({
      method: 'POST',
      path: '/infrastructure/clusters/c1/scaling-groups',
      body: { name: 'general', bounds: { min: 1, desired: 3, max: 5 } },
    });
  });

  it('refuses to write a group with no name or no bounds', async () => {
    const { raw } = await call(
      'scaling_group_set',
      { strategy: 'cheapest' },
      () => GROUP,
    );
    expect(raw).toContain('needs `name` and `bounds`');
  });

  /**
   * A fleet that should hold no nodes was refused by the schema before the API
   * ever saw it, so the one group that most needs saying it could not say it.
   */
  it('lets a group say it should hold no nodes', async () => {
    const { calls } = await call(
      'scaling_group_set',
      { groupId: 'g1', bounds: { min: 0, desired: 0, max: 0 } },
      () => ({ ...GROUP, bounds: { min: 0, desired: 0, max: 0 } }),
    );
    expect(calls[0].body).toEqual({ bounds: { min: 0, desired: 0, max: 0 } });
  });

  it('hands back the money sentence the person was asked to agree to', async () => {
    const { data } = await call(
      'scaling_group_set',
      { groupId: 'g1', bounds: { min: 1, desired: 3, max: 5 } },
      () => GROUP,
    );
    expect(String(data.authorises)).toContain(
      'up to 5 nodes, up to €40 a month, without asking you',
    );
    expect(String(data.note)).toContain('up to 5 nodes');
  });

  /**
   * The half the group cannot state about itself. Letting an agent set a group
   * to `automatic` is agreeing to spending, and what may actually be spent is
   * granted from outside the product — so the sentence handed back has to say
   * which of the two situations the person is now in.
   */
  it('says what the installation granted, beside what the group authorises', async () => {
    const { data } = await call(
      'scaling_group_set',
      { groupId: 'g1', bounds: { min: 1, desired: 3, max: 5 } },
      () => GROUP,
    );
    expect(String(data.authorises)).toContain(GROUP.acts.says);
    expect(data.acts).toEqual(GROUP.acts);
    expect(String(data.note)).toContain('€200 a month');
  });

  it('says an automatic group with no grant will buy nothing at all', async () => {
    const { data } = await call(
      'scaling_group_set',
      { groupId: 'g1', provision: 'automatic' },
      () => UNGRANTED,
    );
    expect(String(data.authorises)).toContain('none of it reaches a provider');
    expect(String(data.note)).toContain('a person acts');
    expect(String(data.note)).not.toContain('€0');
  });

  /**
   * The group's own cap and the installation's grant are two figures, and only
   * the second says what may be spent unattended. Naming a grant that was never
   * made would be the tool inventing the permission it exists to report.
   */
  it('names no grant when none was made, while still quoting the group’s cap', async () => {
    const { data } = await call(
      'scaling_group_set',
      { groupId: 'g1', provision: 'automatic' },
      () => UNGRANTED,
    );
    expect(String(data.authorises)).toContain('up to €40 a month');
    expect(String(data.actsMeans)).not.toMatch(/€/);
  });
});

describe('the sentence a person answers is derived, never written down', () => {
  it('is the group’s own ceiling and its own cap', () => {
    expect(scalingConsequenceOf(GROUP)).toBe(
      'up to 5 nodes, up to €40 a month, without asking you',
    );
    expect(
      scalingConsequenceOf({ ...GROUP, bounds: { ...GROUP.bounds, max: 12 } }),
    ).toContain('up to 12 nodes');
  });

  it('says an absent cap is no ceiling, and never says zero', () => {
    const uncapped = {
      ...GROUP,
      limits: { hourlyBillingOnly: false, maxMonthlyCost: null },
    };
    const sentence = scalingConsequenceOf(uncapped);
    expect(sentence).toContain('no ceiling on the monthly bill');
    expect(sentence).not.toContain('€0');
  });

  it('says who is asked when the group buys nothing on its own', () => {
    expect(
      scalingConsequenceOf({ ...GROUP, provision: 'manual' as const }),
    ).toContain('asking a person before each purchase');
  });

  it('turns into an alarm where nothing can be provisioned', () => {
    expect(scalingConsequenceOf(BYOS)).toContain('raise an alarm for a person');
    expect(scalingConsequenceOf(BYOS)).not.toContain('a month');
  });

  describe('the same derivation, reading the body a person is shown', () => {
    it('reads the ceiling and the cap out of the request itself', () => {
      expect(
        scalingConsequenceClause({
          bounds: { min: 1, desired: 3, max: 5 },
          limits: { maxMonthlyCost: 40 },
          provision: 'automatic',
        }),
      ).toBe('up to 5 nodes, up to €40 a month, without asking you');
    });

    /** The block is replaced whole, so an omitted cap is a cap being removed. */
    it('announces a cap that a limits block drops', () => {
      expect(
        scalingConsequenceClause({
          bounds: { max: 5 },
          limits: { hourlyBillingOnly: true },
        }),
      ).toBe('up to 5 nodes, with no ceiling on the monthly bill');
    });

    it('stays silent about limits the request does not mention', () => {
      expect(scalingConsequenceClause({ bounds: { max: 5 } })).toBe(
        'up to 5 nodes',
      );
    });

    it('says nothing at all rather than guessing, on a body it cannot read', () => {
      expect(scalingConsequenceClause({ name: 'renamed' })).toBeUndefined();
      expect(scalingConsequenceClause('nonsense')).toBeUndefined();
      expect(scalingConsequenceClause(null)).toBeUndefined();
    });
  });
});

describe('what the descriptions teach a model', () => {
  const description = (name: string) => find(name).description;

  it.each([
    ['scaling_group_get', 'NOT AWS’s desired capacity'],
    ['scaling_group_get', 'never waits for a cheaper shape'],
    ['scaling_group_get', 'fitting is a precondition, never a strategy'],
    ['scaling_group_get', 'never a ceiling of zero'],
    ['scaling_group_get', 'never from the provider’s name'],
    ['scaling_overview', 'INCLUDING the clusters that have no scaling group'],
    ['scaling_overview', 'not that the fleet is free'],
    ['scaling_overview', 'FLOOR and not the bill'],
    ['scaling_overview', 'NAMES the groups its cluster holds'],
    ['scaling_group_get', 'WOULD THIS GROUP DO ANYTHING'],
    ['scaling_group_get', 'NO GRANT and never as a grant of €0'],
    ['scaling_group_get', 'that order will never proceed'],
    ['scaling_overview', 'is NOT 0'],
    ['scaling_overview', 'rather than as calm'],
    ['scaling_why', 'DECLINED'],
    ['scaling_why', 'refused-by-limit'],
    ['scaling_why', 'Ask it of the CLUSTER'],
    ['scaling_why', 'reached a provider'],
    ['scaling_why', 'WHICH gate refused it'],
    ['scaling_group_set', 'should hold no nodes'],
    ['scaling_group_set', 'REMOVES the monthly ceiling'],
    ['scaling_group_set', 'retry the identical call'],
    ['scaling_group_set', 'setting a group to automatic buys nothing at all'],
    ['scaling_group_set', 'up to that figure a month without being asked'],
  ])('%s says: %s', (name, phrase) => {
    expect(description(name)).toContain(phrase);
  });

  /**
   * The pause is the route's, and the tool's only job on this surface is to
   * stop and say what was asked for. A tool that carried a confirmation of its
   * own would be a control the same credential skips with `curl`.
   */
  it('keeps no gate of its own in the write tool', () => {
    const source = (
      find('scaling_group_set').run as { toString(): string }
    ).toString();
    for (const smell of ['confirm', 'approved', 'allowDestructive']) {
      expect(source).not.toContain(smell);
    }
  });
});
