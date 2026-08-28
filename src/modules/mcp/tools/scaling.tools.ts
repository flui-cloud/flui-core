import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import {
  ToolDef,
  coerceBoolean,
  coerceNumber,
  defineTool,
  resolveClusterId,
} from './mcp-tool.util';
import {
  scalingConsequenceOf,
  ScalingGroupAuthorityFacts,
} from '../../infrastructure/scaling/scaling-consequence';

/**
 * The scaling group, as much of it as a model can be trusted with.
 *
 * ── Where the pause lives ──────────────────────────────────────────────────
 *
 * Not here. `scaling_group_set` calls the API as the caller's own principal and
 * meets `ActionCycleGuard` on the way in, because
 * `POST /infrastructure/clusters/:clusterId/scaling-groups` and
 * `PATCH /infrastructure/scaling-groups/:id` declare `@ActionCycle`. A
 * confirmation this file performed would be a control the same credential skips
 * with `curl`, and the credential is what says an agent is acting.
 *
 * What the group is, is money: a ceiling on how large a cluster may become and
 * on what it may spend with nobody in the room. That is why the sentence a
 * person answers carries the figure, derived from the bounds and the limits in
 * the very body being proposed — see `scaling-consequence.ts`, which the route's
 * clause and the tools below both read, so "what did I agree to" has one answer.
 *
 * ── The asymmetry, in the tools rather than in a document ───────────────────
 *
 * Capability is read from `canProvision` and `hasCatalogue` and **never from the
 * provider's name**. Half the providers cannot buy a server at all, and for them
 * an autoscaler is not a lesser autoscaler: it is an alarm, which is the
 * contribution an agent is best at. Every projection below carries the sentence
 * that says which of the three worlds the caller is in, so a model does not
 * offer to buy where nothing can be bought — a tool that proposes to scale a
 * cluster that cannot scale is worse than no tool.
 *
 * ── Why `scaling_why` is here at all ────────────────────────────────────────
 *
 * Because the question anybody actually asks an autoscaler is *why did you not
 * scale*, and the answer is a decline. The declines and the alarms are the
 * decisions, not the noise around them, so nothing below filters them out and
 * the projection counts them first.
 */

const enc = encodeURIComponent;

const CLUSTER_ID = z
  .string()
  .optional()
  .describe(
    'Cluster id. Optional when the installation has exactly one cluster.',
  );

interface CapabilityDto {
  provider: string;
  canProvision: boolean;
  hasCatalogue: boolean;
  billing: 'hourly' | 'monthly' | 'none';
}

interface BoundsDto {
  min: number;
  desired: number;
  max: number;
}

interface DrainCheckDto {
  ok: boolean;
  blockers: Array<{ kind: string; what: string; fix: string }>;
  cleared: string[];
}

interface StandingOrderDto {
  kind: string;
  shape: string;
  region: string;
  wanted: number;
  replaces: string | null;
  drainable: DrainCheckDto | null;
}

/**
 * Whether a decision by this group would reach a provider, and what stands in
 * the way when it would not.
 *
 * Optional because an installation one build behind does not send it, and a
 * missing block must not be read as either answer.
 */
interface ActuationDto {
  acts: boolean;
  says: string;
  monthlyEur: number | null;
}

interface GroupDto extends ScalingGroupAuthorityFacts {
  id: string;
  name: string;
  clusterId: string;
  clusterName: string;
  provider: string;
  capability: CapabilityDto;
  bounds: BoundsDto;
  regions: string[];
  shapes: string[];
  strategy: string;
  settleSeconds: number;
  limits: { hourlyBillingOnly: boolean; maxMonthlyCost: number | null };
  provision: 'automatic' | 'manual';
  acts?: ActuationDto;
  standingOrders: StandingOrderDto[];
  requirement: { cpu: string; memory: string } | null;
}

interface DecisionDto {
  id: string;
  at: string;
  force: 'urgency' | 'opportunity';
  outcome: 'added' | 'replaced' | 'removed' | 'declined' | 'alerted';
  saw: string;
  did: string;
  why: string;
  asks: string | null;
  shape: string | null;
  region: string | null;
  hourlyEur: number | null;
  considered: Array<{
    shape: string | null;
    region: string | null;
    hourlyEur: number | null;
    outcome: string;
    note?: string;
  }>;
}

/** A decision read from the cluster carries the group that took it. */
interface ClusterDecisionDto extends DecisionDto {
  groupId: string;
  groupName: string;
}

interface GroupRefDto {
  id: string;
  name: string;
  provision: 'automatic' | 'manual';
  bounds: BoundsDto;
}

interface RowDto {
  clusterId: string;
  clusterName: string;
  capability: CapabilityDto;
  groupId: string | null;
  groupCount: number;
  groups: GroupRefDto[];
  bounds: BoundsDto | null;
  nodes: number;
  monthlyEur: number | null;
  unpricedNodes: number;
  monthlyCap: number | null;
  /** Null is "no group of this cluster could get an answer", never 0. */
  pendingPods: number | null;
  /** Whether any group here would actually reach the provider. */
  acts?: boolean;
  openOrders: number;
  blockedOrders: number;
  openAlarm: { since: string; asks: string } | null;
  lastDecisionAt: string | null;
  needsPerson: string | null;
}

/**
 * The one sentence that decides what a model may offer here.
 *
 * Three worlds, told apart by two flags and never by a name: Flui buys; Flui
 * cannot buy but a catalogue names a shape and a price for a person to buy; no
 * catalogue exists and never will, so the most that can be said is what the
 * machine has to hold.
 */
function capabilityNote(capability: CapabilityDto): string {
  if (capability.canProvision) {
    return 'Flui can buy servers here through the provider API, so a group may grow the cluster on its own.';
  }
  if (capability.hasCatalogue) {
    return 'Flui CANNOT buy servers here. Do not offer to scale this cluster: the most a group can do is raise an alarm naming a shape and its price for a person to buy. Warning is the whole contribution, and it is a real one.';
  }
  return 'Flui CANNOT buy servers here and there is no catalogue — no shape and no price exist to name. Do not offer to scale, and do not name a server type: an alarm can only state what a machine has to hold (the `requirement`).';
}

/** `buy` or `warn`, so a model does not have to infer it from two booleans. */
function whatAnAgentCanDo(capability: CapabilityDto): 'buy' | 'warn' {
  return capability.canProvision ? 'buy' : 'warn';
}

/**
 * What a group authorises, and whether any of it reaches a provider.
 *
 * Two different statements, and a surface carrying only the first is a surface
 * that lies half the time. The bounds and the cap are the group's own opinion of
 * itself and move whenever somebody edits the row; the grant comes from outside
 * the product's data and no API call can widen it. So the group's sentence is
 * derived as it always was, and the installation's own sentence is carried
 * beside it word for word — never a figure written down here, because the only
 * place that knows the figure is the grant.
 */
function authorisedBy(group: GroupDto): string {
  const sentence = scalingConsequenceOf(group);
  const acts = group.acts;
  if (!acts) return sentence;
  return acts.acts
    ? `${sentence}. What actually reaches a provider is bounded by the grant this installation made, not by the group: ${acts.says}`
    : `${sentence} — and as things stand none of it reaches a provider: ${acts.says}`;
}

/** `acts` said as an instruction, so a model does not read the flag as the cap. */
function actuationNote(acts: ActuationDto | undefined): string {
  if (!acts) {
    return 'This installation did not say whether this group would reach a provider — it is running a build without that answer. Do not assume either way.';
  }
  if (!acts.acts) {
    return 'NOTHING this group decides reaches a provider. It decides, writes the decision down, and a person acts. Say that before offering to change anything here, and never report a configured group as one that will grow the cluster.';
  }
  return `Decisions by this group DO reach a provider, up to the grant this installation made — €${acts.monthlyEur} a month, over the whole fleet and not per purchase.`;
}

/**
 * Whether the node a `replace` order would empty can be emptied.
 *
 * The quietest failure in the feature: a replacement whose drain is refused
 * waits for a machine it will never buy, for good, and nothing else tells that
 * apart from patience. Null is not a yes — it is three states that are all "no
 * answer", and reporting an order as ready on one of them invents the very fact
 * the check exists to establish.
 */
function drainNote(drainable: DrainCheckDto | null): string {
  if (!drainable) {
    return 'NOT ANSWERED: no pass has run, the last pass had nothing to drain, or the cluster could not be asked. This is not a yes — do not report this order as ready to proceed.';
  }
  if (drainable.ok) {
    return 'The node this order would empty can be emptied, as of the last pass.';
  }
  return 'HELD BACK: the node this order would empty CANNOT be emptied, so this order will never proceed and the group waits for a machine it will never buy. Relay every blocker with its `what` and its `fix` — each one names something a person has to change.';
}

function standingOrderView(order: StandingOrderDto): Record<string, unknown> {
  const base = {
    kind: order.kind,
    shape: order.shape,
    region: order.region,
    wanted: order.wanted,
    replaces: order.replaces,
  };
  // An expansion drains nothing, so there is nothing to answer about it — and a
  // `drainable: null` beside an expansion would read as an unanswered check.
  return order.kind === 'replace'
    ? {
        ...base,
        drainable: order.drainable,
        drainableMeans: drainNote(order.drainable ?? null),
      }
    : base;
}

function groupView(group: GroupDto): Record<string, unknown> {
  return {
    groupId: group.id,
    name: group.name,
    cluster: `${group.clusterName} (${group.clusterId})`,
    provider: group.provider,
    capability: {
      ...group.capability,
      agentMay: whatAnAgentCanDo(group.capability),
      means: capabilityNote(group.capability),
    },
    bounds: {
      floorHeldNow: group.bounds.min,
      targetApproachedWhenTheMarketAllows: group.bounds.desired,
      ceilingUrgencyMayReachNow: group.bounds.max,
    },
    regionsInOrderOfPreference: group.regions,
    shapesInOrderOfPreference: group.shapes,
    strategy: group.strategy,
    settleSeconds: group.settleSeconds,
    limits: {
      hourlyBillingOnly: group.limits.hourlyBillingOnly,
      // Passed through as null on purpose: a zero here would read as "may spend
      // nothing", which is the opposite of what an absent cap means.
      monthlyCapEur: group.limits.maxMonthlyCost,
    },
    provision: group.provision,
    acts: group.acts ?? null,
    actsMeans: actuationNote(group.acts),
    standingOrders: (group.standingOrders ?? []).map(standingOrderView),
    requirement: group.requirement,
    authorises: authorisedBy(group),
  };
}

function rowView(row: RowDto): Record<string, unknown> {
  return {
    cluster: `${row.clusterName} (${row.clusterId})`,
    capability: {
      provider: row.capability.provider,
      agentMay: whatAnAgentCanDo(row.capability),
      means: capabilityNote(row.capability),
    },
    groupId: row.groupId,
    // Named, not counted: a cluster's second group is exactly the one nobody
    // knows about, and a count leaves it unnamed until somebody asks again.
    groups: (row.groups ?? []).map((g) => ({
      groupId: g.id,
      name: g.name,
      provision: g.provision,
      ceilingUrgencyMayReachNow: g.bounds.max,
    })),
    bounds: row.bounds
      ? {
          floorHeldNow: row.bounds.min,
          targetApproachedWhenTheMarketAllows: row.bounds.desired,
          ceilingUrgencyMayReachNow: row.bounds.max,
        }
      : null,
    nodes: row.nodes,
    monthlyEur: row.monthlyEur,
    monthlyEurMeans: spendNote(row),
    unpricedNodes: row.unpricedNodes ?? 0,
    monthlyCapEur: row.monthlyCap,
    pendingPods: row.pendingPods,
    pendingPodsMeans: pendingNote(row),
    acts: row.acts ?? false,
    actsMeans: actsNote(row),
    openOrders: row.openOrders,
    blockedOrders: row.blockedOrders,
    blockedOrdersMeans:
      row.blockedOrders > 0
        ? `${row.blockedOrders} standing order(s) on this cluster wait for a node that cannot be emptied. They will never proceed on their own; read the group with scaling_group_get and relay each blocker.`
        : 'No standing order here is held back by a drain that cannot happen.',
    openAlarm: row.openAlarm,
    lastDecisionAt: row.lastDecisionAt,
    needsPerson: row.needsPerson,
  };
}

/**
 * Whether a node would actually arrive here, which is not what the provider
 * allows.
 *
 * A model that read `capability.canProvision` alone would tell somebody their
 * stuck pods are about to be answered by a machine that nothing is going to buy.
 */
function actsNote(row: RowDto): string {
  if (!row.capability.canProvision) {
    return 'Flui cannot create a server on this provider at all. Scaling here ends in an alarm addressed to a person, and that is the finished behaviour rather than a setting left off.';
  }
  if (row.acts) {
    return 'A group here is set to buy and this installation granted the spending, so a decision to add a node reaches the provider.';
  }
  return 'Flui COULD create a server here and will not: either every group is set only to decide, or no spending was granted to this installation. Do not tell anyone a node is coming. Read the group with scaling_group_get — its `acts.says` names which of the two it is.';
}

/**
 * What the pending count is, and what its absence is.
 *
 * Null is a cluster no group could get an answer out of, which is the reading a
 * 0 would report as calm — during an outage, on exactly the row somebody is
 * looking at to find out whether there is one.
 */
function pendingNote(row: RowDto): string {
  if (row.pendingPods === null || row.pendingPods === undefined) {
    return 'NOT ANSWERED — no group of this cluster could find out what the scheduler was unable to place. This is not 0 and not calm: report it as unknown, and never as "nothing is waiting".';
  }
  return `${row.pendingPods} pod(s) the scheduler could not place, as the last pass saw them.`;
}

/**
 * What the monthly figure is, per row, in the four cases it can be in.
 *
 * Two of them show nothing for different reasons, and one shows a number that
 * is not the bill. A partially priced fleet reported as its floor is the one
 * mistake nobody checks, because the number looks like an answer.
 */
function spendNote(row: RowDto): string {
  if (row.capability.billing === 'none') {
    return 'There is no bill for this fleet and there never will be: these are the operator’s own machines, which Flui is never billed for. Permanently null — never report it as 0, and never as unknown pricing that might arrive later.';
  }
  if (row.monthlyEur === null) {
    return 'No node here carries a price yet, so there is no figure. That is not a fleet that costs nothing.';
  }
  if ((row.unpricedNodes ?? 0) > 0) {
    return `A FLOOR, not the bill: ${row.unpricedNodes} of ${row.nodes} nodes carry no price and add nothing to this figure. Say so whenever you quote it; the real bill is higher by an unknown amount.`;
  }
  return `The whole fleet is priced: this is what all ${row.nodes} node(s) commit to a month.`;
}

const NULL_PRICE_NOTE =
  'A `monthlyEur` of null is NOT zero: it means Flui has no bill to show for that fleet — the operator’s own machines (`capability.billing: "none"`, permanently), or nodes that carry no price yet. Never report it as free, and never add it up. Where `unpricedNodes` is above 0 the figure is a floor rather than the bill, and `monthlyEurMeans` says which case each row is in.';

const NO_GROUP_NOTE =
  'Rows with `groupId: null` are clusters nobody configured. They are listed on purpose: a cluster with no group will not grow and will raise no alarm when it should have, which is exactly the case a filtered list would hide.';

export const SCALING_TOOLS: ToolDef[] = [
  defineTool({
    name: 'scaling_group_get',
    routes: [
      'GET /infrastructure/scaling-groups/:id',
      'GET /infrastructure/clusters/:clusterId/scaling-groups',
    ],
    description:
      'Read a cluster’s scaling group — what it may buy, how far it may grow, what it may spend and what the provider actually allows. Pass `groupId` for one group, or `clusterId` (or nothing, with a single cluster) for every group a cluster holds. Read the three bounds as three ROLES, not three numbers: `min` is a floor held right now; `desired` is a target approached only opportunistically and is deliberately NOT AWS’s desired capacity — being below it buys nothing on its own; `max` is how far urgency may reach right now. `settleSeconds` is not patience and never waits for a cheaper shape: it waits to be sure a pod is genuinely stuck rather than mid-schedule. `strategy` chooses only among shapes that ALREADY FIT — fitting is a precondition, never a strategy, so no strategy will ever pick a shape the pending pod cannot run on. A `monthlyCapEur` of null is no ceiling at all, never a ceiling of zero. Check `capability` before proposing anything: it is read from flags, never from the provider’s name. Then check `acts`, which answers the only question anybody has here — WOULD THIS GROUP DO ANYTHING — and is a different question from `provision`: two keys turn that lock, the group’s own mode and the spending this installation granted from outside the product, and a group set to `automatic` where nothing was granted decides and buys nothing at all. `acts.says` is the installation’s own sentence; relay it rather than rewording it, and read `acts.monthlyEur: null` as NO GRANT and never as a grant of €0, which is a different instruction. On a `replace` standing order, `drainable` says whether the node it would empty can be emptied: `ok: false` means that order will never proceed, and `null` is no answer at all rather than a yes.',
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: {
      groupId: z
        .string()
        .optional()
        .describe('One group. Omit to list the groups of a cluster.'),
      clusterId: CLUSTER_ID,
    },
    run: async (args, ctx) => {
      if (args.groupId) {
        const group = await ctx.api.get<GroupDto>(
          `/infrastructure/scaling-groups/${enc(args.groupId)}`,
        );
        return [group];
      }
      const clusterId = await resolveClusterId(ctx, args.clusterId);
      return ctx.api.get<GroupDto[]>(
        `/infrastructure/clusters/${enc(clusterId)}/scaling-groups`,
      );
    },
    forModel: (data) => {
      const groups = (Array.isArray(data) ? data : [data]) as GroupDto[];
      return {
        count: groups.length,
        groups: groups.map(groupView),
        ...(groups.length
          ? {}
          : {
              note: 'This cluster has no scaling group. It will not grow, and nothing will raise an alarm when it should have.',
            }),
      };
    },
  }),

  defineTool({
    name: 'scaling_overview',
    routes: [
      'GET /infrastructure/scaling',
      'GET /infrastructure/clusters/:clusterId/scaling',
    ],
    description:
      'One scaling row per cluster on this instance — INCLUDING the clusters that have no scaling group at all, and the clusters that can do nothing but raise an alarm. Those two are the cases somebody is needed for, so they are never filtered out; `needsPerson` is the one line that says which. Pass `clusterId` for a single cluster, or nothing for all of them. Every row NAMES the groups its cluster holds, so a second group is never invisible and no follow-up read is needed to find one. `monthlyEur: null` means Flui has no bill to show, not that the fleet is free — and where `unpricedNodes` is above 0 the figure is a FLOOR and not the bill, so quote it as one. `nodes` above `max` on a cluster Flui cannot provision was not refused by anything — the machines were attached by hand and the ceiling can only report it. `pendingPods: null` is NOT 0: no group of that cluster could find out what the scheduler was unable to place, so report it as unknown rather than as calm — a cluster mid-outage answers nothing and would otherwise read as the quietest row on the list. `blockedOrders` counts standing orders waiting on a node that cannot be emptied; each one is a purchase that will never happen, and nothing else distinguishes it from patience.',
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: { clusterId: CLUSTER_ID },
    run: (args, ctx) =>
      args.clusterId
        ? ctx.api.get<RowDto>(
            `/infrastructure/clusters/${enc(args.clusterId)}/scaling`,
          )
        : ctx.api.get<RowDto[]>('/infrastructure/scaling'),
    forModel: (data) => {
      const rows = (Array.isArray(data) ? data : [data]) as RowDto[];
      return {
        count: rows.length,
        clustersWithoutAGroup: rows.filter((r) => !r.groupId).length,
        clustersThatCanOnlyWarn: rows.filter((r) => !r.capability.canProvision)
          .length,
        needAPerson: rows.filter((r) => r.needsPerson).length,
        rows: rows.map(rowView),
        notes: [NULL_PRICE_NOTE, NO_GROUP_NOTE],
      };
    },
  }),

  defineTool({
    name: 'scaling_why',
    routes: [
      'GET /infrastructure/clusters/:clusterId/scaling-decisions',
      'GET /infrastructure/scaling-groups/:id/decisions',
      'GET /infrastructure/clusters/:clusterId/scaling-groups',
    ],
    description:
      'What was decided on a cluster, and — the half that matters — what was DECLINED, newest first. Ask it of the CLUSTER: pass `clusterId` (or nothing, with a single cluster) and every group answers, each decision naming the group that took it. Pass `groupId` only to narrow it to one group. Never pick a group in order to ask why nothing happened — on a cluster with two groups that answers about the wrong fleet. Read this before ever proposing to scale anything: if the recent decisions are declines, nothing was scaled for the reason each `why` gives, and proposing the same thing again produces the same decline. Declines and alarms are first-class decisions here, not noise: `outcome: "declined"` carries the whole answer in `why`, and `outcome: "alerted"` carries `asks` — the sentence addressed to a person, which nothing in Flui will clear on its own. `considered` lists the candidates walked past with the reason each lost, and two of those reasons must not be collapsed: `over-budget` means the shape cost too much, `refused-by-limit` means it was available and affordable and this group’s own rules excluded it anyway. `outcome: "added"` and `outcome: "removed"` are decisions that reached a provider — a machine was bought, or a node was drained and given back — and their `why` names the gate that let it through and what it committed against the installation’s grant. Relay `why` in full on every outcome: where a purchase was refused it says WHICH gate refused it, in words — the group is set to decide and not act, the installation granted no spending, the amount would pass the grant, a machine is already on its way, the shape carries no price, the region is outside the cluster’s network — and those are six different situations with six different fixes. Never flatten one of them to "scaling did not work". An empty list means the group has decided nothing yet, NOT that it looked and found nothing to do.',
    scope: MCP_SCOPE.INFRA_READ,
    inputSchema: {
      groupId: z
        .string()
        .optional()
        .describe(
          'Narrow the answer to one group. Omit to hear from every group on the cluster.',
        ),
      clusterId: CLUSTER_ID,
      limit: coerceNumber(z.number().int().min(1).max(200))
        .optional()
        .describe('How many decisions to read back. Default 50.'),
    },
    run: async (args, ctx) => {
      const limit = args.limit ? { limit: args.limit } : undefined;
      if (args.groupId) {
        const decisions = await ctx.api.get<DecisionDto[]>(
          `/infrastructure/scaling-groups/${enc(args.groupId)}/decisions`,
          limit,
        );
        return { asked: 'group', groupId: args.groupId, decisions };
      }

      const clusterId = await resolveClusterId(ctx, args.clusterId);
      const decisions = await ctx.api.get<ClusterDecisionDto[]>(
        `/infrastructure/clusters/${enc(clusterId)}/scaling-decisions`,
        limit,
      );
      // Bought only where it is needed: an empty list is two different answers
      // — no group exists, or none has been evaluated — and the second read is
      // the only thing that tells them apart.
      const groups = decisions.length
        ? []
        : await ctx.api.get<GroupDto[]>(
            `/infrastructure/clusters/${enc(clusterId)}/scaling-groups`,
          );
      return { asked: 'cluster', clusterId, decisions, groups };
    },
    forModel: (data) => {
      const d = data as {
        asked: 'group' | 'cluster';
        groupId?: string;
        clusterId?: string;
        decisions: ClusterDecisionDto[];
        groups?: GroupDto[];
      };
      const rows = d.decisions ?? [];
      const counted = (outcome: string) =>
        rows.filter((r) => r.outcome === outcome).length;
      return {
        askedOf: d.asked,
        ...(d.groupId ? { groupId: d.groupId } : {}),
        ...(d.clusterId ? { clusterId: d.clusterId } : {}),
        // Counted before the list, and the declines first: they are the answer
        // to the only question anybody asks an autoscaler.
        declined: counted('declined'),
        alerted: counted('alerted'),
        acted: counted('added') + counted('replaced') + counted('removed'),
        // Broken out beside the total, because "something happened to a machine"
        // and "a machine was bought" are not the same news to relay: `removed`
        // is a node that went back, and `added` is money that was committed.
        added: counted('added'),
        replaced: counted('replaced'),
        removed: counted('removed'),
        openAsks: rows.filter((r) => r.outcome === 'alerted' && r.asks).length,
        decisions: rows.map((r) => ({
          ...(r.groupName ? { group: `${r.groupName} (${r.groupId})` } : {}),
          at: r.at,
          force: r.force,
          outcome: r.outcome,
          saw: r.saw,
          did: r.did,
          why: r.why,
          asks: r.asks,
          shape: r.shape,
          region: r.region,
          hourlyEur: r.hourlyEur,
          considered: r.considered ?? [],
        })),
        note: silenceNote(rows, d.asked, d.groups),
      };
    },
  }),

  defineTool({
    name: 'scaling_group_set',
    routes: [
      'POST /infrastructure/clusters/:clusterId/scaling-groups',
      'PATCH /infrastructure/scaling-groups/:id',
    ],
    description:
      'Write or change a cluster’s scaling group — the standing authority for how large it may grow and how much it may spend unattended. Pass `groupId` to change an existing group, or `clusterId` (or nothing, with a single cluster) plus `name` and `bounds` to write a new one. THIS ASKS A PERSON: the route is inside Flui’s action cycle, so the call comes back as a request carrying the figure it derived from your own bounds and limits — "up to 5 nodes, up to €40 a month, without asking you" — and you must stop, tell the user exactly what was asked for, and retry the identical call once they have answered. `bounds` is replaced whole and so is `limits`: sending `limits` without `maxMonthlyCost` REMOVES the monthly ceiling, it does not leave it alone, so restate the cap every time. `provision: "automatic"` is refused wherever `capability.canProvision` is false — read scaling_group_get first and do not retry it there. Where there is no catalogue, `shapes` and `regions` are refused and `requirement` (what a machine must hold) is required instead; where there is one, the reverse. A standing order may only name a shape and a region the group is already allowed to buy, or it is a wait that can never end. `bounds.max: 0` is accepted and means a fleet that should hold no nodes — a statement, not a group switched off — and it needs `min` and `desired` at 0 as well. `provision: "automatic"` is HALF of what makes a group act: the other half is the spending this installation granted from outside the product, which no call here can widen. With no grant, setting a group to automatic buys nothing at all — it decides, writes the decision down and asks a person, exactly as `manual` would. With one, it may commit up to that figure a month without being asked again. The answer carries `acts` and `acts.says` for this group; read them and tell the user which of the two they now have, and never state a monthly figure that is not the one `acts` came back with.',
    scope: MCP_SCOPE.INFRA_WRITE,
    inputSchema: {
      groupId: z
        .string()
        .optional()
        .describe('Change this group. Omit to write a new one.'),
      clusterId: CLUSTER_ID,
      name: z
        .string()
        .optional()
        .describe('Required when writing a new group; unique per cluster.'),
      bounds: z
        .strictObject({
          min: z
            .number()
            .int()
            .min(0)
            .describe('The floor, held right now and always.'),
          desired: z
            .number()
            .int()
            .min(0)
            .describe(
              'The target, approached only when the market allows. Not AWS’s desired capacity: being below it buys nothing by itself.',
            ),
          max: z
            .number()
            .int()
            .min(0)
            .describe(
              'How far urgency may reach right now. 0 is allowed and is a statement, not a group switched off: this fleet should hold no nodes. On `provision: "manual"` it says every machine present is one somebody attached; on "automatic" it says urgency may buy nothing. It needs min and desired at 0 too.',
            ),
        })
        .optional()
        .describe(
          'All three together, replaced whole: min <= desired <= max or the write is refused.',
        ),
      regions: z
        .array(z.string())
        .optional()
        .describe('Where it may buy. Refused where there is no catalogue.'),
      shapes: z
        .array(z.string())
        .optional()
        .describe(
          'What it may buy, in order of preference — the order IS the preference. Refused where there is no catalogue.',
        ),
      strategy: z
        .enum(['cheapest', 'closest', 'roomiest', 'uniform'])
        .optional()
        .describe(
          'How to choose among the shapes that already fit. Fitting is a precondition, not one of these.',
        ),
      settleSeconds: coerceNumber(z.number().int().min(0).max(3600))
        .optional()
        .describe(
          'How long a pod must have been stuck before this buys. Never a wait for a cheaper shape.',
        ),
      limits: z
        .strictObject({
          hourlyBillingOnly: coerceBoolean().optional(),
          maxMonthlyCost: z
            .number()
            .min(0)
            .nullable()
            .optional()
            .describe(
              'In currency, not in node count. Leaving it out removes the ceiling; it does not set it to zero.',
            ),
        })
        .optional()
        .describe('Replaced whole. Restate every field you want kept.'),
      provision: z
        .enum(['automatic', 'manual'])
        .optional()
        .describe(
          'Refused as "automatic" wherever the provider has no API to create servers.',
        ),
      standingOrders: z
        .array(
          z.strictObject({
            kind: z.enum(['expand', 'replace']),
            shape: z.string(),
            region: z.string(),
            wanted: z.number().int().min(1),
            replaces: z
              .string()
              .nullable()
              .optional()
              .describe(
                'The node to drain and remove. Required for "replace", refused for "expand".',
              ),
          }),
        )
        .optional()
        .describe('What the group would rather be running, when it can be.'),
      requirement: z
        .strictObject({ cpu: z.string(), memory: z.string() })
        .nullable()
        .optional()
        .describe(
          'What a machine has to hold, where no catalogue names shapes. Refused where one does.',
        ),
    },
    run: async (args, ctx) => {
      const { groupId, clusterId, ...rest } = args;
      const body = Object.fromEntries(
        Object.entries(rest).filter(([, value]) => value !== undefined),
      );

      if (groupId) {
        const group = await ctx.api.patch<GroupDto>(
          `/infrastructure/scaling-groups/${enc(groupId)}`,
          body,
        );
        return written(group, 'changed');
      }

      if (!args.name || !args.bounds) {
        throw new Error(
          'Writing a new scaling group needs `name` and `bounds` (min, desired, max). Pass `groupId` instead to change one that already exists.',
        );
      }
      const target = await resolveClusterId(ctx, clusterId);
      const group = await ctx.api.post<GroupDto>(
        `/infrastructure/clusters/${enc(target)}/scaling-groups`,
        body,
      );
      return written(group, 'written');
    },
    forModel: (data) => {
      const d = data as { outcome: string; group: GroupDto; note: string };
      return {
        outcome: d.outcome,
        authorises: authorisedBy(d.group),
        acts: d.group.acts ?? null,
        actsMeans: actuationNote(d.group.acts),
        group: groupView(d.group),
        note: d.note,
      };
    },
  }),
];

function written(
  group: GroupDto,
  outcome: 'written' | 'changed',
): { outcome: string; group: GroupDto; note: string } {
  return {
    outcome,
    group,
    // What a person just agreed to, said back in the same words the request
    // asked it in — and, where nothing can be bought, said as the alarm it
    // really is rather than as a purchase that will never happen. The grant is
    // the half the group cannot state about itself: `automatic` with nothing
    // granted is a group that looks armed and buys nothing at all.
    note: `Tell the user what this now authorises: ${authorisedBy(group)}. ${actuationNote(group.acts)}`,
  };
}

/**
 * What an empty answer means, which is never "everything is fine".
 *
 * A cluster with no group at all will not grow and will raise no alarm when it
 * should have; a cluster whose groups exist but have decided nothing has simply
 * not been evaluated. Reported as the same thing, the first one disappears.
 */
function silenceNote(
  rows: DecisionDto[],
  asked: 'group' | 'cluster',
  groups?: GroupDto[],
): string {
  if (rows.length) {
    return 'A decline is an answer, not a gap. Relay the `why` of the most recent decision rather than proposing the action it already refused, and relay `asks` verbatim on an alarm — nothing here clears one. On `added` and `removed` a machine actually changed and `why` names the gate that let it through, including what it committed against the grant; on a decline the same field names the gate that stopped it. Relay `why` in full either way, and never summarise it as "nothing happened".';
  }
  if (asked === 'cluster' && groups && !groups.length) {
    return 'This cluster has no scaling group, so nothing has been decided for it. It will not grow and it will raise no alarm — say that, rather than reporting that no scaling was needed.';
  }
  const subject =
    asked === 'cluster' ? 'any group on this cluster' : 'this group';
  return `Nothing has been decided for ${subject} yet. That means no reconciliation has run against it, NOT that it looked and found nothing to do — do not report it as "everything is fine".`;
}
