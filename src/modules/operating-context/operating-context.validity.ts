import { ResourceAttributes } from '../iam/interfaces/iam.types';
import {
  CheckKind,
  EntryScope,
  ProbeStatus,
  Validity,
  asSelector,
} from './operating-context.core';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface CheckState {
  checkKind: CheckKind;
  confirmedAt?: Date | string | null;
  validForDays?: number | null;
  lastProbeStatus?: ProbeStatus | null;
}

/**
 * The entry's own answer to "is my premise still true".
 *
 * Three kinds, and the honesty of the whole feature is in keeping them apart
 * instead of pretending every entry is checkable:
 *
 *  - `probe` compares the entry against live state. Only this one can come back
 *    `broken`, and `broken` is the point of the feature: the entry stops
 *    advising and starts asking to be revisited;
 *  - `attestation` is a person's signature with a shelf life. It cannot detect
 *    that the world moved, only that nobody has looked recently — so it decays
 *    to `stale`, never to `broken`;
 *  - `none` is prose, and says so. Marked `unverified` at delivery rather than
 *    quietly presented as fact.
 *
 * A probe that could not run answers `unverified`, not `checked`: an
 * unavailable comparison is not evidence.
 */
export function validityOf(state: CheckState, now = new Date()): Validity {
  switch (state.checkKind) {
    case 'probe':
      return probeValidity(state.lastProbeStatus ?? 'unknown');
    case 'attestation':
      return attestationValidity(state, now);
    default:
      return 'unverified';
  }
}

function probeValidity(status: ProbeStatus): Validity {
  if (status === 'holds') return 'checked';
  return status === 'broken' ? 'broken' : 'unverified';
}

function attestationValidity(state: CheckState, now: Date): Validity {
  if (!state.confirmedAt) return 'stale';
  const days = state.validForDays ?? 0;
  if (days <= 0) return 'stale';
  const at = new Date(state.confirmedAt).getTime();
  return now.getTime() - at <= days * DAY_MS ? 'checked' : 'stale';
}

/**
 * Rule 4 made mechanical: a global entry may not claim to be probe-checked.
 *
 * "Una voce globale non si può confrontare con niente: o è un'intenzione, o è
 * scritta al livello sbagliato." A probe on a global entry would either be a
 * fact about one cluster wearing a platform-wide label, or a tautology. Refused
 * at write, so the model carries the rule instead of a convention.
 */
export function probeAllowedAt(scope: EntryScope): boolean {
  return scope.scopeType !== 'global';
}

/** `broken` never advises; everything else does, carrying its own label. */
export function advisable(v: Validity): boolean {
  return v !== 'broken';
}

/** What a person has to look at again. `stale` appears here *and* in the advice. */
export function needsReview(v: Validity): boolean {
  return v === 'broken' || v === 'stale';
}

/**
 * Does the entry apply to the resource the caller is about to act on?
 *
 * The same predicate `PolicyEngineService.matchesSelector` uses, asked of the
 * entry's scope instead of a grant's. Written here rather than borrowed because
 * the engine keeps its copy private and a caller reaching into it would be the
 * second copy of a boundary, which is the thing that module exists to avoid;
 * `operating-context.core.spec.ts` pins the two saying the same thing.
 */
export function appliesTo(
  scope: EntryScope,
  resource: ResourceAttributes,
): boolean {
  const s = asSelector(scope);
  if (s.owner && (!resource.owner || resource.owner !== s.owner)) return false;
  const pairs: Array<[string | undefined, string | undefined]> = [
    [s.type, resource.type],
    [s.kind, resource.kind],
    [s.clusterId, resource.clusterId],
    [s.clusterName, resource.clusterName],
    [s.provider, resource.provider],
    [s.project, resource.project],
  ];
  if (pairs.some(([sel, res]) => !!sel && sel !== res)) return false;
  if (s.slugs?.length && !(resource.slug && s.slugs.includes(resource.slug)))
    return false;
  if (s.tags?.length && !s.tags.every((t) => resource.tags?.includes(t)))
    return false;
  return true;
}

export interface ConflictCandidate {
  id: string;
  topic: string;
  scopeType: string;
  scopeRef?: string | null;
  selector?: unknown;
}

export interface Conflict {
  topic: string;
  entryIds: string[];
}

/**
 * Entries that reach the same reader, about the same topic, from different
 * levels.
 *
 * **Shown, never resolved.** "Vince il più specifico" would let a note on one
 * application overrule a platform rule, which is the one thing a body of advice
 * must not be able to do. The reader is told both and asks — and a conflict is
 * also the best available signal that one of the two is out of date, which no
 * probe on either of them alone would ever produce.
 */
export function conflictsAmong(entries: ConflictCandidate[]): Conflict[] {
  const byTopic = new Map<string, ConflictCandidate[]>();
  for (const e of entries) {
    byTopic.set(e.topic, [...(byTopic.get(e.topic) ?? []), e]);
  }
  const out: Conflict[] = [];
  for (const [topic, group] of byTopic) {
    const levels = new Set(
      group.map(
        (e) =>
          `${e.scopeType}:${e.scopeRef ?? ''}:${JSON.stringify(e.selector ?? {})}`,
      ),
    );
    if (levels.size > 1) out.push({ topic, entryIds: group.map((e) => e.id) });
  }
  return out.sort((a, b) => a.topic.localeCompare(b.topic));
}
