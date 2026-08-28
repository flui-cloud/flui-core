import type {
  ClusterScalingRowDto,
  DrainCheckDto,
  ProviderScalingCapabilityDto,
  ScalingActuationDto,
  ScalingDecisionResponseDto,
  ScalingGroupResponseDto,
  StandingOrderResponseDto,
} from 'src/modules/infrastructure/scaling/dto/scaling-response.dto';
import type { ScalingPreviewDto } from 'src/modules/infrastructure/scaling/dto/scaling-preview.dto';
import type {
  CandidateOutcome,
  DecisionOutcome,
  PlacementStrategy,
  ProvisionMode,
} from 'src/modules/infrastructure/scaling/scaling.core';
import { SCALING_GROUP_KIND } from './scaling-file';

/** No price at all, which is never the same answer as a price of zero. */
export const NO_PRICE = '—';

export function formatEurPerHour(value: number | null | undefined): string {
  if (value === null || value === undefined) return NO_PRICE;
  return `€${value.toFixed(4)}/h`;
}

export function formatEurPerMonth(value: number | null | undefined): string {
  if (value === null || value === undefined) return NO_PRICE;
  return `€${value.toFixed(2)}/mo`;
}

/** The same amount without the period, for a column already headed by one. */
export function formatEur(value: number | null | undefined): string {
  if (value === null || value === undefined) return NO_PRICE;
  return `€${value.toFixed(2)}`;
}

/**
 * A figure that leaves nodes out carries a mark, so half a fleet's bill can
 * never be read as the whole one.
 */
export const FLOOR_MARK = '+';

type SpendReading = Pick<
  ClusterScalingRowDto,
  'capability' | 'monthlyEur' | 'unpricedNodes' | 'nodes'
>;

export function monthlySpendCell(
  row: Pick<ClusterScalingRowDto, 'monthlyEur' | 'unpricedNodes'>,
): string {
  if (row.monthlyEur === null) return NO_PRICE;
  const amount = formatEur(row.monthlyEur);
  return row.unpricedNodes > 0 ? `${amount}${FLOOR_MARK}` : amount;
}

/**
 * What the monthly figure is, in the four cases it can be in.
 *
 * Two of them show nothing and mean different things: on a provider that bills
 * nobody there is no bill and there never will be, and that is read off
 * `billing` rather than off a name; everywhere else an absent figure means no
 * node carries a price yet. And a fleet that is only partly priced is a floor,
 * never the bill — said out loud, because a number that reads low is the one
 * mistake nobody checks.
 */
export function describeMonthlySpend(row: SpendReading): string {
  if (row.capability.billing === 'none') {
    return (
      `${NO_PRICE} is no bill at all, and here it is permanent: these are the operator’s own ` +
      'machines and Flui never sees a bill for them.'
    );
  }
  if (row.monthlyEur === null) {
    return (
      `${NO_PRICE} — no node here carries a price yet, so there is no figure to show. ` +
      'That is not a fleet that costs nothing.'
    );
  }
  if (row.unpricedNodes > 0) {
    return (
      `${monthlySpendCell(row)} is a floor, not the bill: ${row.unpricedNodes} of ${row.nodes} ` +
      'nodes carry no price and add nothing to it.'
    );
  }
  return `${formatEur(row.monthlyEur)} a month, over all ${row.nodes} node${row.nodes === 1 ? '' : 's'}.`;
}

/**
 * No answer, which is never the same reading as an answer of none.
 *
 * `pendingPods` is null when no group of a cluster could get an answer out of
 * it — a cluster mid-outage looks exactly like a calm one if that is printed as
 * 0, and calm is the one thing it is not.
 */
export const NO_ANSWER = '?';

export function pendingPodsCell(
  row: Pick<ClusterScalingRowDto, 'pendingPods'>,
): string {
  return typeof row.pendingPods === 'number'
    ? String(row.pendingPods)
    : NO_ANSWER;
}

/** Whether the cell is one somebody should look at: waiting work, or silence. */
export function pendingPodsWarns(
  row: Pick<ClusterScalingRowDto, 'pendingPods'>,
): boolean {
  return row.pendingPods === null || row.pendingPods > 0;
}

export interface ActuationView {
  acts: boolean;
  verdict: string;
  /** The API's own sentence, carried word for word — it owns the wording. */
  says: string;
  /** The monthly grant, formatted. `—` is no grant, which is not a grant of €0. */
  grant: string;
}

/**
 * Whether anything this group decides would reach a provider.
 *
 * The sentence is the API's and is passed through untouched: two keys turn this
 * lock — the group says it may act, the installation says how much it may
 * commit — and a second copy of that wording in the CLI would be a second
 * answer to the only question worth asking a scaling group.
 *
 * Null where the API did not send the block at all, which is an installation one
 * build behind rather than a group that does nothing.
 */
export function describeActuation(
  group: Pick<ScalingGroupResponseDto, 'acts'>,
): ActuationView | null {
  const acts: ScalingActuationDto | undefined = group.acts;
  if (!acts) return null;
  return {
    acts: acts.acts,
    verdict: acts.acts ? 'yes' : 'no',
    says: acts.says,
    grant: formatEurPerMonth(acts.monthlyEur),
  };
}

export interface DrainView {
  ok: boolean;
  headline: string;
  blockers: Array<{ what: string; fix: string }>;
  cleared: string[];
}

/**
 * Whether the node a replacement would empty can be emptied.
 *
 * A `replace` order whose drain is refused is the quietest failure in the
 * feature: the group waits for a machine it will never buy, for good, and
 * nothing else distinguishes that from patience. So the refusal is never a
 * flag — every blocker is named with the thing that blocks and what would have
 * to change.
 */
export function describeDrain(
  drainable: DrainCheckDto | null | undefined,
): DrainView | null {
  if (!drainable) return null;
  return {
    ok: drainable.ok,
    headline: drainable.ok
      ? 'the node this order would empty can be emptied'
      : 'held back: the node this order would empty cannot be emptied, so it will never proceed',
    blockers: (drainable.blockers ?? []).map((blocker) => ({
      what: blocker.what,
      fix: blocker.fix,
    })),
    cleared: drainable.cleared ?? [],
  };
}

/** How a standing order reads in one line, before anything about its drain. */
export function describeStandingOrder(order: StandingOrderResponseDto): string {
  const where = `${order.wanted} × ${order.shape} at ${order.region}`;
  return order.kind === 'replace'
    ? `${where}, draining ${order.replaces ?? '?'}`
    : where;
}

/** The groups a cluster holds, named — a count leaves the second one invisible. */
export function groupNames(
  row: Pick<ClusterScalingRowDto, 'groups' | 'groupCount'>,
): string {
  const named = (row.groups ?? []).map((g) => g.name);
  if (named.length) return named.join(', ');
  return row.groupCount
    ? `${row.groupCount} group${row.groupCount === 1 ? '' : 's'}`
    : 'none';
}

export function formatBounds(bounds: {
  min: number;
  desired: number;
  max: number;
}): string {
  return `floor ${bounds.min} · target ${bounds.desired} · ceiling ${bounds.max}`;
}

function formatMoment(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${at.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

function relativeAge(iso: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const seconds = Math.max(
    0,
    Math.round((now.getTime() - at.getTime()) / 1000),
  );
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * What this installation can do about its own size, read from the declared
 * flags and never from the provider's name.
 *
 * The three answers are not a ladder. A provider with a catalogue and no way to
 * create a server is not a lesser version of one that can buy: it is a
 * different sentence, addressed to a person, and it can still name a shape and
 * a price. Where there is no catalogue there never will be one, so the same
 * sentence can only say what the machine has to hold.
 */
export function describeCapability(
  capability: ProviderScalingCapabilityDto,
): string {
  if (capability.canProvision) {
    return `Flui can add servers on ${capability.provider} (billed ${capability.billing}).`;
  }
  if (capability.hasCatalogue) {
    return (
      `Flui cannot add servers on ${capability.provider}: scaling here raises an alarm for a person, ` +
      'naming the shape it would have bought and what it costs.'
    );
  }
  return (
    `Flui cannot add servers on ${capability.provider} and no catalogue names shapes here: ` +
    'scaling raises an alarm saying what the machine has to hold.'
  );
}

/** The short form for a table cell. */
export function capabilityLabel(
  capability: ProviderScalingCapabilityDto,
): string {
  if (capability.canProvision) return 'can buy';
  return capability.hasCatalogue ? 'alarm (named)' : 'alarm (described)';
}

const STRATEGY_MEANINGS: Record<PlacementStrategy, string> = {
  cheapest: 'the lowest hourly price, in any region this group may buy in',
  closest:
    'the cluster’s own region first, then the others in the order listed',
  roomiest:
    'the largest that stays within the limits, so the next piece of work fits too',
  uniform: 'the same shape as the nodes already running',
};

/**
 * The strategies choose *among the shapes that already fit*. Fitting is not one
 * of them: were it a preference, `cheapest` would buy the shape that helps
 * nobody and the work would still be waiting after the money was spent.
 */
export function describeStrategy(strategy: PlacementStrategy): string {
  return `${STRATEGY_MEANINGS[strategy]} — chosen among the shapes that already fit the waiting work`;
}

export function describeSettle(seconds: number): string {
  return (
    `${seconds}s — how long work must have been stuck before this buys. ` +
    'Never a wait for a cheaper shape.'
  );
}

const BOUND_MEANINGS = {
  min: 'held now, always',
  desired:
    'approached when the market allows — being under it buys nothing now',
  max: 'as far as urgency may go right now',
};

/**
 * A ceiling of zero is a statement, not a group switched off: this fleet should
 * hold no nodes. What it states depends on who does the buying — a group that
 * never buys is describing the machines that are already there, and one that
 * does is saying urgency may buy nothing.
 */
export function describeZeroCeiling(provision: ProvisionMode): string {
  return provision === 'automatic'
    ? 'no nodes: urgency may buy nothing'
    : 'no nodes: every machine here is one somebody attached';
}

export interface BoundRow {
  role: string;
  field: string;
  value: number;
  meaning: string;
}

export function boundRows(
  bounds: {
    min: number;
    desired: number;
    max: number;
  },
  provision: ProvisionMode = 'manual',
): BoundRow[] {
  return [
    {
      role: 'floor',
      field: 'min',
      value: bounds.min,
      meaning: BOUND_MEANINGS.min,
    },
    {
      role: 'target',
      field: 'desired',
      value: bounds.desired,
      meaning: BOUND_MEANINGS.desired,
    },
    {
      role: 'ceiling',
      field: 'max',
      value: bounds.max,
      meaning:
        bounds.max === 0 ? describeZeroCeiling(provision) : BOUND_MEANINGS.max,
    },
  ];
}

const CANDIDATE_REASONS: Record<CandidateOutcome, string> = {
  'would-buy': 'this is the one it would buy',
  unavailable: 'nothing to buy there right now',
  'does-not-fit': 'too small for the work that is waiting',
  'over-budget': 'the monthly ceiling would be passed',
  'refused-by-limit':
    'available and affordable, and this group’s own rules exclude it',
  alert: 'nothing can be bought here — a person is asked instead',
};

export function candidateReason(outcome: CandidateOutcome): string {
  return CANDIDATE_REASONS[outcome] ?? outcome;
}

const OUTCOME_MEANINGS: Record<DecisionOutcome, string> = {
  added: 'a node was added',
  replaced: 'a node was bought and another drained',
  removed: 'a node was drained and removed',
  declined: 'nothing was done, on purpose',
  alerted: 'nothing could be bought — this asks a person',
};

export function outcomeMeaning(outcome: DecisionOutcome): string {
  return OUTCOME_MEANINGS[outcome] ?? outcome;
}

export interface DecisionLine {
  label: string;
  text: string;
}

export interface CandidateRow {
  shape: string;
  region: string;
  price: string;
  outcome: CandidateOutcome;
  reason: string;
}

export interface DecisionView {
  outcome: DecisionOutcome;
  headline: string;
  at: string;
  age: string;
  lines: DecisionLine[];
  candidates: CandidateRow[];
}

/**
 * The four lines a decision is made of, in the order somebody asks for them:
 * what it saw, what it did, why — and, when nothing could be bought, what it
 * wants a person to go and do.
 *
 * A decline is not a missing decision. It is the answer to the only question
 * anybody ever asks an autoscaler, so it renders exactly like a purchase.
 */
export function describeDecision(
  decision: ScalingDecisionResponseDto,
  now: Date = new Date(),
): DecisionView {
  const lines: DecisionLine[] = [
    { label: 'saw', text: decision.saw },
    { label: 'did', text: decision.did },
    { label: 'why', text: decision.why },
  ];
  if (decision.asks) lines.push({ label: 'asks', text: decision.asks });

  const shape = decision.shape ?? null;
  if (shape) {
    const where = decision.region ? ` at ${decision.region}` : '';
    lines.push({
      label: 'shape',
      text: `${shape}${where} · ${formatEurPerHour(decision.hourlyEur)}`,
    });
  }

  return {
    outcome: decision.outcome,
    headline: `${decision.outcome} · ${decision.force}`,
    at: formatMoment(decision.at),
    age: relativeAge(decision.at, now),
    lines,
    candidates: (decision.considered ?? []).map((candidate) => ({
      shape: candidate.shape ?? NO_PRICE,
      region: candidate.region ?? NO_PRICE,
      price: formatEurPerHour(candidate.hourlyEur),
      outcome: candidate.outcome,
      reason: candidate.note?.trim() || candidateReason(candidate.outcome),
    })),
  };
}

export interface LadderRow {
  step: string;
  describes: string;
  shape: string;
  region: string;
  price: string;
  outcome: CandidateOutcome;
  reason: string;
}

/** Every rung the engine walked, in the order it walked them. */
export function ladderRows(preview: ScalingPreviewDto): LadderRow[] {
  return (preview.ladder ?? []).map((rung) => ({
    step: String(rung.step),
    describes: rung.describes,
    shape: rung.shape ?? NO_PRICE,
    region: rung.region ?? NO_PRICE,
    price: formatEurPerHour(rung.hourlyEur),
    outcome: rung.outcome,
    reason: rung.note?.trim() || candidateReason(rung.outcome),
  }));
}

/**
 * The largest request the scheduler could not place, where there is one.
 *
 * An absent one is two states and the preview says which: nothing is waiting,
 * or the cluster could not be asked — and only the first may be read as calm.
 * The second is the one `opportunityHeldBecause` states, so the answer is taken
 * from the pair rather than from the absence alone.
 */
export function describePending(
  preview: Pick<ScalingPreviewDto, 'pending' | 'opportunityHeldBecause'>,
): string {
  const pending = preview.pending;
  if (pending) {
    return `${pending.app} · ${pending.cpu} cpu · ${pending.memory}`;
  }
  return preview.opportunityHeldBecause
    ? 'nothing is named as waiting, which is not the same as nothing waiting'
    : 'nothing was waiting for capacity when this was read';
}

/** The rung that would win, or the fact that the answer is an alarm instead. */
export function describeChosen(preview: ScalingPreviewDto): string {
  const chosen = preview.chosen;
  if (!chosen) {
    return 'nothing would be bought — the answer here is an alarm, not a purchase';
  }
  const where = chosen.region ? ` at ${chosen.region}` : '';
  return `${chosen.shape ?? NO_PRICE}${where} · ${formatEurPerHour(chosen.hourlyEur)}`;
}

/**
 * What to say when the log is empty, which is the commonest thing `why` meets.
 *
 * Derived from the group rather than asserted: an installation that cannot buy
 * will never record a purchase here, and saying so up front is more useful than
 * the empty list.
 */
export function describeSilence(group: ScalingGroupResponseDto): string[] {
  const said = [
    'No decisions recorded for this group yet. One is written the first time it is ' +
      'evaluated — including when it decides to do nothing.',
  ];
  const asks = willOnlyAsk(group);
  if (asks) said.push(asks);
  return said;
}

/** Why this group will never record a purchase, when that is already known. */
function willOnlyAsk(group: ScalingGroupResponseDto): string | null {
  if (!group.capability.canProvision) {
    return describeCapability(group.capability);
  }
  if (group.provision === 'manual') {
    return (
      'This group provisions manually: it will ask a person rather than buy, even though ' +
      `Flui can add servers on ${group.capability.provider}.`
    );
  }
  return null;
}

/**
 * The same silence, asked of a cluster.
 *
 * A cluster with no group at all is a different answer from a cluster whose
 * groups have decided nothing yet, and reading the second as the first is how
 * "nothing happened" gets reported as "all is well".
 */
export function describeClusterSilence(
  groups: ScalingGroupResponseDto[],
): string[] {
  if (!groups.length) {
    return [
      'No scaling group on this cluster, so nothing has been decided and nothing will be: ' +
        'it will not grow, and it will raise no alarm when it should have.',
      'Write one with `flui scaling apply -f <file>`.',
    ];
  }
  const said = [
    `No decisions recorded yet for any of the ${groups.length === 1 ? 'group' : `${groups.length} groups`} ` +
      'on this cluster. One is written the first time a group is evaluated — including when it ' +
      'decides to do nothing.',
  ];
  for (const group of groups) {
    const asks = willOnlyAsk(group);
    if (asks) said.push(`${group.name}: ${asks}`);
  }
  return said;
}

/** The one line of a cluster row that has to read from across the room. */
export function rowAttention(row: ClusterScalingRowDto): string | null {
  if (row.needsPerson) return row.needsPerson;
  if (row.openAlarm) {
    return `${row.openAlarm.asks} (since ${formatMoment(row.openAlarm.since)})`;
  }
  return null;
}

/**
 * The group as a document again: the fields somebody wrote, without the ones
 * the API derives.
 *
 * `capability`, `provider` and the ids are readings of the world rather than
 * statements about the group, and an availability outlook would be stale by the
 * time the file was committed. What is left round-trips through `apply`.
 */
export function toScalingGroupDocument(
  group: ScalingGroupResponseDto,
): Record<string, unknown> {
  return {
    kind: SCALING_GROUP_KIND,
    name: group.name,
    cluster: group.clusterName,
    bounds: {
      min: group.bounds.min,
      desired: group.bounds.desired,
      max: group.bounds.max,
    },
    regions: group.regions ?? [],
    shapes: group.shapes ?? [],
    strategy: group.strategy,
    settleSeconds: group.settleSeconds,
    limits: {
      hourlyBillingOnly: group.limits.hourlyBillingOnly,
      maxMonthlyCost: group.limits.maxMonthlyCost,
    },
    provision: group.provision,
    standingOrders: (group.standingOrders ?? []).map((order) => {
      const written: Record<string, unknown> = {
        kind: order.kind,
        shape: order.shape,
        region: order.region,
        wanted: order.wanted,
      };
      if (order.kind === 'replace') written.replaces = order.replaces;
      return written;
    }),
    requirement: group.requirement
      ? { cpu: group.requirement.cpu, memory: group.requirement.memory }
      : null,
  };
}
