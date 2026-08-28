/**
 * What a scaling group authorises, said in one line of prose.
 *
 * Two readers, one derivation. The route's `@ActionCycle` clause reads the
 * unvalidated body a person is being asked to approve; the MCP tool reads the
 * group the API answered with, where the defaults are already applied and the
 * provider's capability travels beside it. Writing the sentence twice would be
 * writing two answers to "what did I just agree to".
 *
 * Nothing here reads a table or calls anything: a clause is fed a raw body
 * before the pipes have run, and a clause that fails for a reason unrelated to
 * the decision is worse than a shorter sentence.
 */

const PROVISION_TAIL: Record<string, string> = {
  automatic: 'without asking you',
  manual: 'asking a person before each purchase',
};

export interface ScalingAuthority {
  /** The ceiling urgency may reach. Null when the request does not restate it. */
  max: number | null;
  /**
   * `null` is no ceiling at all and `undefined` is "not stated in this
   * request" — two different sentences, and neither of them is zero.
   */
  monthlyCapEur: number | null | undefined;
  provision: 'automatic' | 'manual' | undefined;
}

function moneyPhrase(cap: number | null | undefined): string | null {
  if (cap === undefined) return null;
  return cap === null
    ? 'with no ceiling on the monthly bill'
    : `up to €${cap} a month`;
}

/** The bare authority, with no provider in the picture. */
export function scalingAuthoritySentence(
  authority: ScalingAuthority,
): string | undefined {
  const parts: string[] = [];
  if (authority.max !== null) parts.push(`up to ${authority.max} nodes`);
  const money = moneyPhrase(authority.monthlyCapEur);
  if (money) parts.push(money);
  if (!parts.length) return undefined;
  const tail = authority.provision
    ? PROVISION_TAIL[authority.provision]
    : undefined;
  if (tail) parts.push(tail);
  return parts.join(', ');
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The clause a person reads under the request, derived from the body they are
 * being asked to approve.
 *
 * A `limits` block that is present without a cap is a cap being *removed*, so
 * it has to speak; a `limits` block that is absent leaves the cap alone and
 * must stay silent, or the sentence would announce a change nobody made.
 */
export function scalingConsequenceClause(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as {
    bounds?: { max?: unknown } | null;
    limits?: { maxMonthlyCost?: unknown } | null;
    provision?: unknown;
  };
  const provision =
    b.provision === 'automatic' || b.provision === 'manual'
      ? b.provision
      : undefined;
  return scalingAuthoritySentence({
    max: finiteNumber(b.bounds?.max),
    monthlyCapEur: b.limits ? finiteNumber(b.limits.maxMonthlyCost) : undefined,
    provision,
  });
}

export interface ScalingGroupAuthorityFacts {
  bounds: { max: number };
  limits: { maxMonthlyCost: number | null };
  provision: 'automatic' | 'manual';
  capability: { canProvision: boolean; hasCatalogue: boolean };
}

/**
 * The same sentence for a group that already exists, where the provider's
 * declarations are known.
 *
 * The asymmetry lives here rather than in prose about it: where nothing can be
 * provisioned the ceiling is not a budget, it is the figure an alarm quotes —
 * and where there is no catalogue there is no figure at all, only what a
 * machine has to hold.
 */
export function scalingConsequenceOf(
  group: ScalingGroupAuthorityFacts,
): string {
  const nodes = `up to ${group.bounds.max} nodes`;

  if (!group.capability.hasCatalogue) {
    return `${nodes}, and Flui buys none of them: with no catalogue there is no shape and no price to name, so this group can only say what a machine has to hold and raise an alarm for a person`;
  }

  const money =
    group.limits.maxMonthlyCost === null
      ? 'with no ceiling on the monthly bill'
      : `up to €${group.limits.maxMonthlyCost} a month`;

  if (!group.capability.canProvision) {
    return `${nodes}, ${money} — and Flui buys none of them here: it names a shape and its price in an alarm, and a person buys it`;
  }

  return `${nodes}, ${money}, ${PROVISION_TAIL[group.provision]}`;
}

/**
 * What a person is agreeing to when they let this be written.
 *
 * It must hold in both worlds, because it cannot see which one it is in: an
 * action cycle's consequence is a fixed sentence, and the spending grant lives
 * outside the product's data where no request body reaches it. The earlier
 * wording — *"where Flui can buy servers it buys within it"* — promised a
 * purchase that an installation with no grant never makes, which is the wrong
 * half of the two to be wrong about: it invites consent to spending that either
 * happens or does not, on a fact this sentence cannot check.
 */
export const SCALING_CONSEQUENCE =
  'This becomes the standing limit the cluster is sized and billed against. ' +
  'Whether anything is actually bought against it needs two things that are ' +
  'not in this request: the group set to buy automatically, and a spending ' +
  'grant made to this installation outside the product. With either missing ' +
  'the group decides, writes down what it would have bought, and stops — and ' +
  'where the provider has no create API at all, this is simply the figure an ' +
  'alarm quotes to a person.';
