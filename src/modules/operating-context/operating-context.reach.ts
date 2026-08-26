import {
  CONTEXT_SCOPE_TYPES,
  ContextScopeType,
  ENTRY_NATURES,
  EntryNature,
  EntryScope,
} from './operating-context.core';

/** The shape of the audience, for a screen that switches on it. */
export type ReachAudience = 'installation' | 'cluster' | 'selection';

/**
 * Who a note at this level reaches, in one sentence and in the two or three
 * facts a caller might want to act on.
 *
 * It is **an occasion to notice, not a filter**. Nothing here refuses anything:
 * what a note is — the *how it is done here* or the *why* — is declared by
 * whoever writes it, and rule 2 is what it means. The line exists because that
 * rule surprises people in one direction: a global practice descends to every
 * tenant and to the guests of the demonstration, on purpose, and somebody about
 * to write the first one should read that before they press save rather than
 * discover it afterwards.
 *
 * Computed here and served by the API rather than phrased three times, so the
 * dashboard, the CLI and the sentence a person approves in the action cycle
 * cannot drift into saying different things about the same note.
 */
export interface EntryReach {
  audience: ReachAudience;
  scopeType: ContextScopeType;
  scopeRef?: string | null;
  nature: EntryNature;
  /** Does it descend to everyone who acts inside the scope? `practice` does. */
  descends: boolean;
  /**
   * Is a guest of the demonstration among them?
   *
   * True for a practice at a level a guest can act inside. A selection is not
   * counted: whether it picks a guest out depends on the selector, and a line
   * that guessed would be worse than one that says less.
   */
  reachesGuests: boolean;
  sentence: string;
}

const NAMED = (ref?: string | null): string => ref || 'this cluster';

const PRACTICE: Record<ContextScopeType, (ref?: string | null) => string> = {
  global: () =>
    'Everyone who works on this installation reads this: every tenant, and the ' +
    'guests of the demonstration. It does not stop at the people who run the platform.',
  cluster: (ref) =>
    `Everyone who works on cluster ${NAMED(ref)} reads this, down to a tenant ` +
    'who has a single application there.',
  selector: () =>
    'Everyone who works on the resources this note selects reads this, whether ' +
    'or not they own them.',
};

const RATIONALE: Record<ContextScopeType, (ref?: string | null) => string> = {
  global: () =>
    'Only a principal whose access covers the whole installation reads this.',
  cluster: (ref) =>
    `Only a principal whose access covers the whole of cluster ${NAMED(ref)} ` +
    'reads this; a tenant with an application on it does not.',
  selector: () =>
    'Only a principal whose access covers this whole selection reads this.',
};

const AUDIENCE: Record<ContextScopeType, ReachAudience> = {
  global: 'installation',
  cluster: 'cluster',
  selector: 'selection',
};

/**
 * The line, for a note that exists or for one somebody is about to write.
 *
 * A pure function of the level and the nature: it reads nothing, so asking it
 * about a level tells the asker nothing they could not work out from the two
 * words they just supplied. That is what makes it safe to answer before the
 * note exists, which is the half of the job that matters — a warning delivered
 * only on re-reading arrives after the mistake.
 */
export function reachOf(scope: EntryScope, nature: EntryNature): EntryReach {
  const descends = nature === 'practice';
  const say = descends ? PRACTICE : RATIONALE;
  return {
    audience: AUDIENCE[scope.scopeType],
    scopeType: scope.scopeType,
    scopeRef: scope.scopeRef ?? null,
    nature,
    descends,
    reachesGuests: descends && scope.scopeType !== 'selector',
    sentence: say[scope.scopeType](scope.scopeRef),
  };
}

/**
 * The reach line for a note somebody is about to write, read off the body of
 * the request that would write it.
 *
 * This is the half of decided rule 2 the action cycle could not say. A person
 * approving an agent's `POST /operating-context` was shown *write a new
 * operating-context note* — true, and silent about the one thing that surprises
 * people: a global practice descends to every tenant and to the guests of the
 * demonstration. The level is in the body, so no route parameter could ever
 * have carried it.
 *
 * Written for a guard, which means two properties rather than one:
 *
 *  - **pure.** It reads nothing. The whole answer is a function of the two
 *    words the caller just supplied, which is what {@link reachOf} already is;
 *  - **suspicious of its argument.** Guards run before validation, so this is
 *    handed whatever was posted. Anything it cannot recognise as a level and a
 *    nature answers `undefined`, and the sentence stays exactly as declared —
 *    the request is refused a moment later by the pipe anyway, and a guard that
 *    threw on a malformed body would turn a 400 into a 500.
 */
export function reachClauseOf(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const { scopeType, nature, scopeRef } = body as Record<string, unknown>;
  if (!isScopeType(scopeType) || !isNature(nature)) return undefined;
  return reachOf(
    { scopeType, scopeRef: typeof scopeRef === 'string' ? scopeRef : null },
    nature,
  ).sentence;
}

const isScopeType = (v: unknown): v is ContextScopeType =>
  typeof v === 'string' &&
  (CONTEXT_SCOPE_TYPES as readonly string[]).includes(v);

const isNature = (v: unknown): v is EntryNature =>
  typeof v === 'string' && (ENTRY_NATURES as readonly string[]).includes(v);
