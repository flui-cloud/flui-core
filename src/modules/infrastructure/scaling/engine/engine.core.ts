import {
  CatalogueReading,
  ShapeAvailability,
  upWhereAllowed,
} from '../catalogue/catalogue.core';
import {
  CandidateOutcome,
  NodeRequirement,
  PlacementStrategy,
} from '../scaling.core';

export const MONTH_HOURS = 730;

/**
 * What the system takes off every node before a pod can have any of it. A shape
 * that holds the request only with nothing left for the kubelet does not hold
 * it, and a purchase that leaves the pod pending is the one failure this whole
 * mechanism exists to avoid.
 */
export const NODE_RESERVE = { cpuMillicores: 200, memoryMi: 512 };

export interface ShapePrice {
  region: string;
  hourlyEur: number | null;
  monthlyEur: number | null;
}

/** A shape as the provider's own catalogue describes it. */
export interface ShapeFact {
  shape: string;
  cores: number;
  memoryMi: number;
  deprecated: boolean;
  supportsHourlyBilling: boolean;
  prices: ShapePrice[];
}

export interface ShapeFactsReading {
  shapes: ShapeFact[];
  /** False when nobody could read the provider's sizes, which is not an empty catalogue. */
  read: boolean;
}

export interface PendingDemand {
  name: string;
  cpuMillicores: number;
  memoryMi: number;
}

export interface FleetFacts {
  nodes: number;
  /** The shape of each node, where the fleet knows it. */
  shapes: string[];
  /** What the priced nodes already commit to. A floor, not the whole bill. */
  committedMonthlyEur: number;
  unpricedNodes: number;
}

/** A node row, reduced to the two things a fleet reading takes from it. */
export interface PricedNodeRow {
  serverType?: string | null;
  hourlyPriceEur?: number | null;
}

/**
 * The fleet as the node rows describe it, falling back to the cluster's own
 * count where the table holds no row: installations older than the writing of
 * those rows have machines running that nothing ever recorded, and a fleet of
 * zero would be the one reading that is certainly wrong.
 *
 * A node with no price contributes nothing rather than zero, and is counted, so
 * the total is a floor whenever `unpricedNodes` is not 0.
 */
export function fleetOf(
  rows: PricedNodeRow[],
  fallback: { nodes: number; shape: string | null },
): FleetFacts {
  if (!rows.length) {
    return {
      nodes: fallback.nodes,
      shapes: fallback.shape
        ? Array.from({ length: fallback.nodes }, () => fallback.shape as string)
        : [],
      committedMonthlyEur: 0,
      unpricedNodes: fallback.nodes,
    };
  }

  const priced = rows.filter(
    (row): row is PricedNodeRow & { hourlyPriceEur: number } =>
      typeof row.hourlyPriceEur === 'number',
  );
  return {
    nodes: rows.length,
    shapes: rows
      .map((row) => row.serverType)
      .filter((shape): shape is string => Boolean(shape)),
    committedMonthlyEur: priced.reduce(
      (total, row) => total + row.hourlyPriceEur * MONTH_HOURS,
      0,
    ),
    unpricedNodes: rows.length - priced.length,
  };
}

export interface LadderCapability {
  canProvision: boolean;
  hasCatalogue: boolean;
  billing: 'hourly' | 'monthly' | 'none';
}

export interface LadderGroup {
  provider: string;
  regions: string[];
  shapes: string[];
  strategy: PlacementStrategy;
  hourlyBillingOnly: boolean;
  maxMonthlyCost: number | null;
  requirement: NodeRequirement | null;
  capability: LadderCapability;
}

export interface LadderInput {
  group: LadderGroup;
  clusterRegion: string;
  /** `max` for urgency and `desired` for opportunity: how far this force may go. */
  ceiling: number;
  fleet: FleetFacts;
  demand: PendingDemand | null;
  shapes: ShapeFactsReading;
  catalogue: CatalogueReading;
}

export interface LadderRung {
  step: number;
  describes: string;
  shape: string | null;
  region: string | null;
  hourlyEur: number | null;
  outcome: CandidateOutcome;
  note?: string;
}

export interface LadderResult {
  rungs: LadderRung[];
  /** The rung that would win, and null whenever the answer is an alarm. */
  chosen: LadderRung | null;
  /** The sentence addressed to a person, on an alarm. */
  asks: string | null;
}

interface Candidate {
  shape: string;
  region: string;
  fact: ShapeFact | null;
  hourlyEur: number | null;
  monthlyEur: number | null;
  outcome: CandidateOutcome;
  note?: string;
  preference: number;
  regionRank: number;
}

const STEPS: {
  describes: string;
  preferredOnly: boolean;
  homeOnly: boolean;
}[] = [
  {
    describes: 'The preferred shape, in the cluster’s own region',
    preferredOnly: true,
    homeOnly: true,
  },
  {
    describes: 'The preferred shape, in any region this group may buy in',
    preferredOnly: true,
    homeOnly: false,
  },
  {
    describes: 'Anything that holds it, in the cluster’s own region',
    preferredOnly: false,
    homeOnly: true,
  },
  {
    describes: 'Anything that holds it, in any region this group may buy in',
    preferredOnly: false,
    homeOnly: false,
  },
];

/**
 * The reasons a rung can lose, ordered by how near the rung came to buying.
 *
 * A shape that fits and is to be had and is refused by a setting is one
 * checkbox away from a purchase; a shape that cannot hold the request was never
 * a candidate. The rung reports the nearest miss, because that is the one a
 * person can act on.
 */
const REFUSED_BY_LIMIT: CandidateOutcome = 'refused-by-limit';

const NEARNESS: CandidateOutcome[] = [
  REFUSED_BY_LIMIT,
  'over-budget',
  'unavailable',
  'does-not-fit',
];

/**
 * The urgency ladder: five rungs, walked in order, stopping at the first that
 * would work.
 *
 * Nothing here waits and nothing here spends. Every rung that loses says why it
 * lost, which is the substance of the answer — an autoscaler is only ever asked
 * why it did *not* scale.
 */
export function walkLadder(input: LadderInput): LadderResult {
  const rungs: LadderRung[] = [];
  const preferred = preferredShape(input);

  // The four steps differ by which shape and which region they will accept.
  // With no shape to name anywhere they cannot differ at all, and walking them
  // prints the same non-answer four times — which reads as four things tried.
  const nothingToName =
    !preferred &&
    input.group.shapes.length === 0 &&
    input.shapes.shapes.length === 0;
  const steps = nothingToName ? STEPS.slice(0, 1) : STEPS;

  for (const [index, step] of steps.entries()) {
    const rung = walkStep(input, index + 1, step, preferred);
    rungs.push(rung);
    if (rung.outcome === 'would-buy') {
      // Where nothing can be provisioned the winning rung is still not a
      // purchase: it is the machine an alarm asks a person to attach.
      if (!input.group.capability.canProvision) {
        const alerted = asAlert(rung, input);
        rungs[rungs.length - 1] = alerted;
        return { rungs, chosen: null, asks: alerted.note ?? null };
      }
      return { rungs, chosen: rung, asks: null };
    }
  }

  const asks = alarmAsk(input, rungs);
  rungs.push({
    step: STEPS.length + 1,
    describes: 'Nothing left to try',
    shape: null,
    region: null,
    hourlyEur: null,
    outcome: 'alert',
    note: asks,
  });
  return { rungs, chosen: null, asks };
}

/**
 * The shape the group would rather have. Its own order of preference, except
 * under `uniform`, where the preference is whatever the fleet already is —
 * which is what happens today without anybody choosing it.
 */
export function preferredShape(input: LadderInput): string | null {
  const declared = input.group.shapes;
  if (!declared.length) return null;
  if (input.group.strategy !== 'uniform') return declared[0];
  const dominant = dominantShape(input.fleet.shapes);
  return dominant && declared.includes(dominant) ? dominant : declared[0];
}

function dominantShape(shapes: string[]): string | null {
  const counts = new Map<string, number>();
  for (const shape of shapes) {
    counts.set(shape, (counts.get(shape) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [shape, count] of counts) {
    if (count > bestCount) {
      best = shape;
      bestCount = count;
    }
  }
  return best;
}

function shapesFor(
  input: LadderInput,
  preferredOnly: boolean,
  preferred: string | null,
): string[] {
  if (!preferredOnly) return input.group.shapes;
  return preferred ? [preferred] : [];
}

function walkStep(
  input: LadderInput,
  step: number,
  shape: { describes: string; preferredOnly: boolean; homeOnly: boolean },
  preferred: string | null,
): LadderRung {
  const shapes = shapesFor(input, shape.preferredOnly, preferred);
  const regions = regionsFor(input, shape.homeOnly);

  if (!shapes.length) {
    return {
      step,
      describes: shape.describes,
      shape: null,
      region: null,
      hourlyEur: null,
      outcome: 'unavailable',
      note: noShapeNote(input),
    };
  }
  if (!regions.length) {
    return {
      step,
      describes: shape.describes,
      shape: shapes[0],
      region: null,
      hourlyEur: null,
      // Only the home rung is a refusal: there the group excludes the region
      // its own cluster sits in, which is a rule somebody wrote. A fallback
      // rung with nowhere left to look is not refusing anything.
      outcome: shape.homeOnly ? REFUSED_BY_LIMIT : 'unavailable',
      note: noRegionNote(input, shape.homeOnly),
    };
  }

  const candidates = rank(
    shapes.flatMap((name) =>
      regions.map((region) => judge(input, name, region)),
    ),
    input,
  );

  const winner = candidates.find((c) => c.outcome === 'would-buy');
  if (winner) return toRung(step, shape.describes, winner);

  const nearest =
    NEARNESS.map((outcome) =>
      candidates.find((c) => c.outcome === outcome),
    ).find((c): c is Candidate => c !== undefined) ?? candidates[0];
  return toRung(step, shape.describes, nearest);
}

function toRung(
  step: number,
  describes: string,
  candidate: Candidate,
): LadderRung {
  return {
    step,
    describes,
    shape: candidate.shape,
    region: candidate.region,
    hourlyEur: candidate.hourlyEur,
    outcome: candidate.outcome,
    note: candidate.note,
  };
}

function asAlert(rung: LadderRung, input: LadderInput): LadderRung {
  return {
    ...rung,
    outcome: 'alert',
    note: manualPurchaseAsk(rung, input),
  };
}

/**
 * Where the group named no region, the regions the provider offers the shape in
 * are the ones it may buy in: an empty allow-list is "anywhere", never
 * "nowhere".
 */
function regionsFor(input: LadderInput, homeOnly: boolean): string[] {
  const allowed = input.group.regions.length
    ? input.group.regions
    : offeredRegions(input);
  if (homeOnly) {
    return allowed.includes(input.clusterRegion) ? [input.clusterRegion] : [];
  }
  return allowed.filter((region) => region !== input.clusterRegion);
}

function offeredRegions(input: LadderInput): string[] {
  const regions = new Set<string>();
  for (const shape of input.shapes.shapes) {
    if (!input.group.shapes.includes(shape.shape)) continue;
    for (const price of shape.prices) regions.add(price.region);
  }
  return [...regions];
}

function judge(input: LadderInput, shape: string, region: string): Candidate {
  const fact =
    input.shapes.shapes.find((entry) => entry.shape === shape) ?? null;
  const price = fact?.prices.find((entry) => entry.region === region) ?? null;
  const base: Candidate = {
    shape,
    region,
    fact,
    hourlyEur: price?.hourlyEur ?? null,
    monthlyEur: price?.monthlyEur ?? null,
    outcome: 'would-buy',
    preference: Math.max(0, input.group.shapes.indexOf(shape)),
    regionRank: regionRank(input, region),
  };

  const refused = refusedBy(input, base);
  if (refused) return { ...base, ...refused };

  const floor = budgetFloorNote(input);
  return floor ? { ...base, note: floor } : base;
}

/**
 * What the budget check could not prove.
 *
 * `over-budget` fires only on certainty, since an unpriced node adds nothing to
 * the committed figure — so clearing the ceiling is never proof of being under
 * it. Where the fleet is only partly priced the figure the ceiling was checked
 * against is a floor, and it is said out loud rather than left to be inferred
 * from a number that looks exact.
 */
export function budgetFloorNote(input: LadderInput): string | null {
  const cap = input.group.maxMonthlyCost;
  if (cap === null || input.fleet.unpricedNodes === 0) return null;
  return `€${round(input.fleet.committedMonthlyEur)} a month is committed over the priced nodes alone: ${input.fleet.unpricedNodes} node(s) carry no price, so the figure weighed against the €${cap} ceiling is a floor and not the bill.`;
}

interface Verdict {
  outcome: CandidateOutcome;
  note: string;
}

function refusedBy(input: LadderInput, candidate: Candidate): Verdict | null {
  const { group, fleet } = input;

  if (fleet.nodes >= input.ceiling) {
    return {
      outcome: REFUSED_BY_LIMIT,
      note: `The fleet is at ${fleet.nodes} nodes and this force may not go past ${input.ceiling}.`,
    };
  }

  // The whole catalogue, refused by one setting — which from the outside looks
  // exactly like the provider having nothing to sell.
  if (group.hourlyBillingOnly && group.capability.billing === 'monthly') {
    return {
      outcome: REFUSED_BY_LIMIT,
      note: `${group.provider} bills monthly and this group takes hourly billing only, so every shape it publishes is refused.`,
    };
  }

  if (!candidate.fact) {
    return {
      outcome: 'unavailable',
      note: input.shapes.read
        ? `${group.provider} publishes no shape called ${candidate.shape}.`
        : `The sizes of ${group.provider} could not be read, so nothing here can say what ${candidate.shape} holds or costs.`,
    };
  }

  if (candidate.fact.deprecated) {
    return {
      outcome: REFUSED_BY_LIMIT,
      note: `${candidate.shape} is deprecated: buying one now buys a machine on its way out.`,
    };
  }
  if (group.hourlyBillingOnly && !candidate.fact.supportsHourlyBilling) {
    return {
      outcome: REFUSED_BY_LIMIT,
      note: `${candidate.shape} is a monthly commitment and this group takes hourly billing only.`,
    };
  }

  const fit = doesNotFit(candidate.fact, input.demand);
  if (fit) return fit;

  if (!candidate.fact.prices.some((p) => p.region === candidate.region)) {
    return {
      outcome: 'unavailable',
      note: `${candidate.shape} is not offered in ${candidate.region}.`,
    };
  }

  const down = reportedDown(input, candidate);
  if (down) return down;

  return overBudget(input, candidate);
}

function doesNotFit(
  fact: ShapeFact,
  demand: PendingDemand | null,
): Verdict | null {
  if (!demand) return null;
  const cpu = fact.cores * 1000 - NODE_RESERVE.cpuMillicores;
  const memory = fact.memoryMi - NODE_RESERVE.memoryMi;
  if (cpu >= demand.cpuMillicores && memory >= demand.memoryMi) return null;
  return {
    outcome: 'does-not-fit',
    note: `${fact.shape} leaves ${Math.max(0, Math.round(cpu))}m and ${Math.max(0, Math.round(memory))}Mi for a pod asking ${demand.cpuMillicores}m and ${demand.memoryMi}Mi.`,
  };
}

/**
 * A shape the catalogue does not name is not ruled out: not knowing narrows
 * nothing, and walking past a rung on the strength of silence would be the
 * catalogue deciding rather than informing.
 */
function reportedDown(
  input: LadderInput,
  candidate: Candidate,
): Verdict | null {
  const availability: ShapeAvailability | undefined =
    input.catalogue.shapes.find((entry) => entry.shape === candidate.shape);
  if (!availability) return null;
  if (upWhereAllowed(availability, [candidate.region]).length) return null;
  return {
    outcome: 'unavailable',
    note: `The availability catalogue reports ${candidate.shape} down in ${candidate.region}${agedBy(input.catalogue)}.`,
  };
}

function agedBy(reading: CatalogueReading): string {
  return reading.ageSeconds === null
    ? ' (age of that reading unknown)'
    : ` (read ${reading.ageSeconds}s ago)`;
}

function overBudget(input: LadderInput, candidate: Candidate): Verdict | null {
  const cap = input.group.maxMonthlyCost;
  if (cap === null) return null;
  const monthly = monthlyOf(candidate);
  if (monthly === null) return null;
  const committed = input.fleet.committedMonthlyEur;
  if (committed + monthly <= cap) return null;
  const unpriced = input.fleet.unpricedNodes
    ? ` — and ${input.fleet.unpricedNodes} node(s) carry no price, so the real bill is higher still`
    : '';
  return {
    outcome: 'over-budget',
    note: `€${round(committed)} a month is already committed and ${candidate.shape} in ${candidate.region} adds €${round(monthly)}, against a ceiling of €${cap}${unpriced}.`,
  };
}

function monthlyOf(candidate: Candidate): number | null {
  if (candidate.monthlyEur !== null) return candidate.monthlyEur;
  return candidate.hourlyEur === null
    ? null
    : candidate.hourlyEur * MONTH_HOURS;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function regionRank(input: LadderInput, region: string): number {
  if (region === input.clusterRegion) return -1;
  const declared = input.group.regions.indexOf(region);
  return declared === -1 ? Number.MAX_SAFE_INTEGER : declared;
}

/**
 * The four strategies choose among the shapes that already survived the filter.
 * None of them can promote a shape that does not hold the request, because such
 * a shape never reaches here.
 */
function rank(candidates: Candidate[], input: LadderInput): Candidate[] {
  const preferred = preferredShape(input);
  const compare = comparator(input.group.strategy, preferred);
  return [...candidates].sort(compare);
}

function comparator(
  strategy: PlacementStrategy,
  preferred: string | null,
): (a: Candidate, b: Candidate) => number {
  switch (strategy) {
    case 'cheapest':
      return (a, b) =>
        byPrice(a, b) ||
        a.preference - b.preference ||
        a.regionRank - b.regionRank;
    case 'closest':
      return (a, b) =>
        a.regionRank - b.regionRank ||
        a.preference - b.preference ||
        byPrice(a, b);
    case 'roomiest':
      return (a, b) =>
        byRoom(a, b) || byPrice(a, b) || a.regionRank - b.regionRank;
    case 'uniform':
      return (a, b) =>
        Number(a.shape !== preferred) - Number(b.shape !== preferred) ||
        a.preference - b.preference ||
        a.regionRank - b.regionRank ||
        byPrice(a, b);
  }
}

/** A price nobody knows sorts last rather than as free. */
function byPrice(a: Candidate, b: Candidate): number {
  if (a.hourlyEur === b.hourlyEur) return 0;
  if (a.hourlyEur === null) return 1;
  if (b.hourlyEur === null) return -1;
  return a.hourlyEur - b.hourlyEur;
}

function byRoom(a: Candidate, b: Candidate): number {
  const memory = (b.fact?.memoryMi ?? 0) - (a.fact?.memoryMi ?? 0);
  return memory || (b.fact?.cores ?? 0) - (a.fact?.cores ?? 0);
}

function noShapeNote(input: LadderInput): string {
  return input.group.capability.hasCatalogue
    ? `This group names no shape it may buy on ${input.group.provider}.`
    : `${input.group.provider} publishes no catalogue, so no rung can name a shape here.`;
}

function noRegionNote(input: LadderInput, homeOnly: boolean): string {
  if (homeOnly) {
    return `The cluster sits in ${input.clusterRegion}, which is not among the regions this group may buy in.`;
  }
  return input.group.regions.length
    ? `There is no second region to try: this group may only buy in ${input.group.regions.join(', ')}.`
    : 'No other region is known to offer these shapes.';
}

/** What a machine has to hold, said the way a person would go and buy one. */
export function requirementLine(input: LadderInput): string {
  if (input.demand) {
    return `${input.demand.cpuMillicores}m of CPU and ${input.demand.memoryMi}Mi of memory (plus room for the system)`;
  }
  if (input.group.requirement) {
    // "500m of CPU" reads correctly and "4 of CPU" does not. A requirement is
    // written by a person and may carry a unit or not; the sentence has to work
    // either way, because it is the whole of what an alarm can say here.
    const cpu = /^\d+(\.\d+)?$/.test(input.group.requirement.cpu.trim())
      ? `${input.group.requirement.cpu} CPU`
      : `${input.group.requirement.cpu} of CPU`;
    return `${cpu} and ${input.group.requirement.memory} of memory`;
  }
  return 'the capacity this cluster is short of';
}

function manualPurchaseAsk(rung: LadderRung, input: LadderInput): string {
  const price =
    rung.hourlyEur === null
      ? ', price unknown'
      : ` at €${rung.hourlyEur}/h, about €${round(rung.hourlyEur * MONTH_HOURS)} a month`;
  return `Buy a ${rung.shape} in ${rung.region}${price} and join it with \`flui node connect\`. Flui cannot create a server on ${input.group.provider}.`;
}

/**
 * The last rung, and on two of the three capability cases it is the whole
 * product rather than a step toward one.
 */
export function alarmAsk(input: LadderInput, rungs: LadderRung[]): string {
  const need = requirementLine(input);

  if (!input.group.capability.hasCatalogue) {
    return `Attach a machine holding ${need} and join it with \`flui node connect\`. ${input.group.provider} publishes no catalogue, so no shape and no price can be named here.`;
  }

  const named = rungs.find((rung) => rung.shape !== null);
  const because = rungs
    .filter((rung) => rung.note)
    .map((rung) => rung.note as string)
    .filter((note, index, all) => all.indexOf(note) === index)
    .join(' ');

  if (!input.group.capability.canProvision) {
    const shape = named?.shape
      ? `The nearest shape this group names is ${named.shape}. `
      : '';
    return `Attach a machine holding ${need} and join it with \`flui node connect\`: Flui cannot create a server on ${input.group.provider}. ${shape}${because}`;
  }

  return `Nothing this group may buy can be had for ${need}. ${because} Widen its shapes or regions, raise what it may spend, or attach a machine yourself.`;
}

/**
 * One shape in one region, for a standing order that has already named both.
 *
 * The patient side does not walk a ladder: it is waiting for a particular
 * machine in a particular place, and every reason a rung can lose applies to it
 * unchanged.
 */
export function evaluateShape(
  input: LadderInput,
  shape: string,
  region: string,
): LadderRung {
  const candidate = judge(input, shape, region);
  return {
    step: 1,
    describes: `${shape} in ${region}`,
    shape,
    region,
    hourlyEur: candidate.hourlyEur,
    outcome: candidate.outcome,
    note: candidate.note,
  };
}

/** What the rungs amount to, without repeating a reason two of them share. */
/**
 * Why the rungs lost — and never the alarm's own sentence.
 *
 * The last rung of a ladder that found nothing carries the ask, which is
 * printed on its own line beside this one. Folding it in here made `why` end
 * with the whole of `asks` repeated word for word, on the command people run
 * precisely when they want the short version.
 */
export function reasonsOf(rungs: LadderRung[]): string {
  const notes = rungs
    .filter((rung) => rung.outcome !== 'alert')
    .map((rung) => rung.note)
    .filter((note): note is string => Boolean(note));
  return [...new Set(notes)].join(' ');
}

export function monthlyFrom(hourlyEur: number | null): number | null {
  return hourlyEur === null ? null : round(hourlyEur * MONTH_HOURS);
}

export function roundEur(value: number): number {
  return round(value);
}
