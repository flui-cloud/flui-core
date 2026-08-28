/**
 * The vocabulary of a scaling group, in one place because four surfaces spell
 * it: the entity, the request validators, the response shapes and the tests.
 */

export const PLACEMENT_STRATEGIES = [
  'cheapest',
  'closest',
  'roomiest',
  'uniform',
] as const;

/**
 * How to choose among the shapes that *already fit*.
 *
 * "It fits" is not one of them. A shape that cannot hold the pending pod is not
 * a candidate at all — were fitting a preference, `cheapest` would pick the
 * shape that helps nobody and the pod would still be waiting after the money
 * was spent.
 */
export type PlacementStrategy = (typeof PLACEMENT_STRATEGIES)[number];

export const PROVISION_MODES = ['automatic', 'manual'] as const;
export type ProvisionMode = (typeof PROVISION_MODES)[number];

export const STANDING_ORDER_KINDS = ['expand', 'replace'] as const;

/**
 * `expand` is the common one: a purchase and nothing else. `replace` is that
 * same purchase **plus a drain** — two nodes alive at once, a step that can
 * fail halfway, and a feasibility question the other does not have.
 */
export type StandingOrderKind = (typeof STANDING_ORDER_KINDS)[number];

export const SCALING_FORCES = ['urgency', 'opportunity'] as const;
export type ScalingForce = (typeof SCALING_FORCES)[number];

export const DECISION_OUTCOMES = [
  'added',
  'replaced',
  'removed',
  'declined',
  'alerted',
] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];

export const CANDIDATE_OUTCOMES = [
  'would-buy',
  'unavailable',
  'does-not-fit',
  'over-budget',
  'refused-by-limit',
  'alert',
] as const;

/**
 * `refused-by-limit` is separate from `over-budget`: the shape is available and
 * affordable and the group's own rules exclude it anyway. From the outside that
 * looks exactly like an outage unless it is said in different words.
 */
export type CandidateOutcome = (typeof CANDIDATE_OUTCOMES)[number];

/** What a standing order is *configured* as, before anything looks at a market. */
export interface StandingOrderConfig {
  kind: StandingOrderKind;
  shape: string;
  region: string;
  /** How many are still wanted, to reach the target patiently. */
  wanted: number;
  /** The node it would drain and remove. Always null when kind is `expand`. */
  replaces: string | null;
}

/** What a machine has to hold, where there is no catalogue to name a shape from. */
export interface NodeRequirement {
  cpu: string;
  memory: string;
}

/** A rung walked past, kept so a decision can say what it did *not* choose. */
export interface ConsideredCandidate {
  shape: string | null;
  region: string | null;
  hourlyEur: number | null;
  outcome: CandidateOutcome;
  note?: string;
}

/**
 * What a decision would actually do to the fleet, where it would do anything.
 *
 * The seam between deciding and acting, and the reason it is an object rather
 * than a flag: everything needed to spend money is here, and the engine never
 * holds anything that could spend it. Null on every decision that concludes in
 * words, which is most of them and all of them on a provider Flui cannot buy
 * from.
 */
export interface ScalingIntent {
  kind: 'add' | 'replace' | 'remove';
  shape: string | null;
  region: string | null;
  hourlyEur: number | null;
  /** The node to drain and remove. Null on `add`. */
  node: string | null;
  /**
   * True where removing this node is the second half of a replacement rather
   * than a fleet that overshot.
   *
   * The two look identical afterwards — one node fewer — and they are not the
   * same event: one completes something a person asked for, the other undoes an
   * overshoot. Without this the decision log spells both `removed`, and
   * `replaced` is a word the vocabulary has and nothing ever writes.
   */
  completesReplacement?: boolean;
  /** What the fleet already commits. A floor wherever `unpricedNodes` is not 0. */
  fleetMonthlyEur: number;
  unpricedNodes: number;
  fleetNodes: number;
}
