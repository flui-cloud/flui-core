import type { LedgerEntry, ScrubResourceKind } from './ledger';
import { describeEvidence, readOwnership } from './ownership';

/**
 * Deciding what `flui env scrub` may delete.
 *
 * Two sources, neither trusted alone. The **ledger** says what a run created;
 * it can name things that no longer exist and it is written by a process that
 * died. **Discovery** says what exists on the account right now; it sees the
 * customer's whole account, most of which is none of our business. A resource
 * is a candidate for removal only where the two agree *and* the product's own
 * ownership mark is on it.
 *
 * Everything else is reported, never acted on:
 *
 *  - named but absent → already gone, nothing to do;
 *  - present and Flui-marked but *not* named → `unclaimed`. This is the
 *    category `env orphan-volumes` deletes, and the reason it is dangerous: a
 *    Flui mark says "Flui made this", not "this run made this", so a customer's
 *    second cluster looks exactly like litter from the first;
 *  - present and named but unmarked, ambiguous, older than the run, or holding
 *    a server we are not removing → refused, with the check that failed.
 *
 * The whole decision is a pure function of two lists so it can be falsified
 * without a provider account: this file is what a test can lie to.
 */

export interface DiscoveredResource {
  readonly provider: string;
  readonly kind: ScrubResourceKind;
  readonly providerId: string;
  readonly name: string;
  readonly region?: string | null;
  readonly labels: Readonly<Record<string, string>>;
  /** Provider timestamp, when the provider reports one. */
  readonly createdAt?: string | null;
  /** For volumes: the server holding it, if any. */
  readonly attachedTo?: string | null;
}

export type ScrubVerdict = 'remove' | 'already-gone' | 'released' | 'refused';

export interface ScrubDecision {
  readonly entry: LedgerEntry;
  readonly match: DiscoveredResource | null;
  readonly verdict: ScrubVerdict;
  readonly reason: string;
}

export interface ScrubPlan {
  readonly decisions: readonly ScrubDecision[];
  readonly removals: readonly ScrubDecision[];
  readonly refusals: readonly ScrubDecision[];
  /** Flui-marked resources on the account that this ledger does not name. */
  readonly unclaimed: readonly DiscoveredResource[];
}

export interface ScrubPlanInput {
  readonly ledger: readonly LedgerEntry[];
  readonly discovered: readonly DiscoveredResource[];
  /** Clusters this machine still holds in its own store. */
  readonly knownClusterIds?: Iterable<string>;
  /** How far a provider clock may sit behind the ledger's. Default 60 minutes. */
  readonly clockSkewMinutes?: number;
}

/**
 * Order of destruction. Servers first because they hold the volumes and the
 * firewall; keys last because they are the cheapest thing to leave behind and
 * the only one whose loss is irreversible for a still-running machine.
 */
const REMOVAL_ORDER: readonly ScrubResourceKind[] = [
  'server',
  'volume',
  'firewall',
  'network',
  'ssh-key',
];

export function planScrub(input: ScrubPlanInput): ScrubPlan {
  const known = new Set(input.knownClusterIds ?? []);
  const skewMs = (input.clockSkewMinutes ?? 60) * 60_000;

  const claimed = new Set<DiscoveredResource>();
  const first: ScrubDecision[] = input.ledger.map((entry) => {
    const decision = decide(entry, input.discovered, known, skewMs);
    if (decision.match) claimed.add(decision.match);
    return decision;
  });

  const decisions = withheldAttachments(first).sort(byRemovalOrder);

  return {
    decisions,
    removals: decisions.filter((d) => d.verdict === 'remove'),
    refusals: decisions.filter((d) => d.verdict === 'refused'),
    unclaimed: input.discovered.filter(
      (resource) => !claimed.has(resource) && readOwnership(resource).owned,
    ),
  };
}

function decide(
  entry: LedgerEntry,
  discovered: readonly DiscoveredResource[],
  known: ReadonlySet<string>,
  skewMs: number,
): ScrubDecision {
  if (entry.releasedAt) {
    return {
      entry,
      match: null,
      verdict: 'released',
      reason: `the run deleted it at ${entry.releasedAt}`,
    };
  }

  const sameKind = discovered.filter((d) => d.kind === entry.kind);

  if (entry.providerId) {
    const byId = sameKind.filter((d) =>
      sameProviderId(d.providerId, entry.providerId as string),
    );
    if (byId.length > 1) return ambiguous(entry, `id ${entry.providerId}`);
    if (byId.length === 1) return inspect(entry, byId[0], known, skewMs);
  }

  const byName = sameKind.filter((d) => d.name === entry.name);
  if (byName.length === 0) {
    return {
      entry,
      match: null,
      verdict: 'already-gone',
      reason: 'nothing on the account answers to it',
    };
  }
  if (byName.length > 1) return ambiguous(entry, `the name ${entry.name}`);

  if (entry.providerId) {
    return {
      entry,
      match: null,
      verdict: 'refused',
      reason: `the list gives id ${entry.providerId}, but the only ${entry.kind} with this name is ${byName[0].providerId}`,
    };
  }

  return inspect(entry, byName[0], known, skewMs);
}

function inspect(
  entry: LedgerEntry,
  match: DiscoveredResource,
  known: ReadonlySet<string>,
  skewMs: number,
): ScrubDecision {
  const ownership = readOwnership(match);
  if (!ownership.owned) {
    return {
      entry,
      match,
      verdict: 'refused',
      reason: `${describeEvidence(ownership.evidence)} — it is not ours to delete`,
    };
  }

  if (ownership.clusterId && known.has(ownership.clusterId)) {
    return {
      entry,
      match,
      verdict: 'refused',
      reason: `it belongs to cluster ${ownership.clusterId}, which this machine still has in its store`,
    };
  }

  const predates = predatesRun(entry.createdAt, match.createdAt, skewMs);
  if (predates) {
    return {
      entry,
      match,
      verdict: 'refused',
      reason: `the provider says it was created at ${match.createdAt}, before the run announced it at ${entry.createdAt}`,
    };
  }

  return {
    entry,
    match,
    verdict: 'remove',
    reason: describeEvidence(ownership.evidence),
  };
}

/**
 * A volume the plan would delete while a server the plan is *not* deleting
 * still holds it.
 *
 * Detaching a disk out from under a running machine is the failure mode worth
 * naming: it is silent, it happens after the confirmation, and the damage is
 * to data rather than to a bill.
 */
function withheldAttachments(
  decisions: readonly ScrubDecision[],
): ScrubDecision[] {
  const goingAway = new Set(
    decisions
      .filter((d) => d.verdict === 'remove' && d.entry.kind === 'server')
      .map((d) => d.match?.providerId)
      .filter((id): id is string => !!id),
  );

  return decisions.map((decision) => {
    const holder = decision.match?.attachedTo;
    if (decision.verdict !== 'remove' || !holder) return decision;
    if ([...goingAway].some((id) => sameProviderId(id, holder))) {
      return decision;
    }
    return {
      ...decision,
      verdict: 'refused',
      reason: `it is still attached to server ${holder}, which this list does not remove`,
    };
  });
}

function ambiguous(entry: LedgerEntry, by: string): ScrubDecision {
  return {
    entry,
    match: null,
    verdict: 'refused',
    reason: `more than one ${entry.kind} on the account answers to ${by}`,
  };
}

/**
 * Scaleway's block API addresses a volume as `<zone>:<id>` in some places and
 * bare in others, and the two forms are the same resource. Comparing the raw
 * strings is the bug that makes a safety check quietly stop firing, so the tail
 * is compared too.
 */
export function sameProviderId(a: string, b: string): boolean {
  if (!a || !b) return false;
  return a === b || tail(a) === tail(b);
}

function tail(value: string): string {
  const colon = value.lastIndexOf(':');
  return colon >= 0 ? value.slice(colon + 1) : value;
}

/**
 * The run announced every resource *before* creating it (ADR-007), so a
 * provider timestamp that sits earlier than the announcement — by more than the
 * clocks can plausibly disagree — belongs to something that already existed.
 */
function predatesRun(
  announced: string | null,
  observed: string | null | undefined,
  skewMs: number,
): boolean {
  if (!announced || !observed) return false;
  const a = Date.parse(announced);
  const o = Date.parse(observed);
  if (Number.isNaN(a) || Number.isNaN(o)) return false;
  return o < a - skewMs;
}

function byRemovalOrder(a: ScrubDecision, b: ScrubDecision): number {
  const rank =
    REMOVAL_ORDER.indexOf(a.entry.kind) - REMOVAL_ORDER.indexOf(b.entry.kind);
  return rank !== 0 ? rank : a.entry.name.localeCompare(b.entry.name);
}
