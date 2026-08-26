import {
  IamSelector,
  PrincipalAccess,
  ScopedGrant,
} from '../iam/interfaces/iam.types';

/**
 * Where a context entry applies.
 *
 * Deliberately the same three words a grant uses, minus `section`: a portal
 * section is not a place a resource sits, and `PolicyEngineService.scopeApplies`
 * already answers `false` for it against every resource. An entry scoped to a
 * section could not be compared with anything the platform knows, which is the
 * property rule 4 is about.
 */
export const CONTEXT_SCOPE_TYPES = ['global', 'cluster', 'selector'] as const;

export type ContextScopeType = (typeof CONTEXT_SCOPE_TYPES)[number];

/**
 * What kind of thing the entry says, and the axis reach is decided on.
 *
 * `practice` is *how it is done here*: it descends to anybody who acts inside
 * the scope, because withholding it from a tenant takes the advice away from
 * exactly the person with the least idea of the local rules. `rationale` is the
 * *why* — an incident, a name, a commercial choice — and stays with whoever
 * owns the level.
 *
 * This is the whole of decided rule 2, and it is written on the entry rather
 * than on the person on purpose: the division is by nature of the entry, at
 * every level.
 */
export const ENTRY_NATURES = ['practice', 'rationale'] as const;

export type EntryNature = (typeof ENTRY_NATURES)[number];

/** How an entry's premise is checked. See {@link Validity}. */
export type CheckKind = 'none' | 'attestation' | 'probe';

export type ProbeStatus = 'holds' | 'broken' | 'unknown';

/**
 * What the reader is told about the entry's premise.
 *
 * - `checked`  — a probe agreed with the entry, or a person confirmed it inside
 *                its declared window;
 * - `stale`    — a confirmation lapsed. Not known wrong, only unconfirmed;
 * - `broken`   — the platform's own state contradicts the entry's premise. This
 *                is the one that must never be delivered as advice;
 * - `unverified` — prose. Either it carries no check, or its probe could not
 *                run. An honest label, not a failure.
 */
export type Validity = 'checked' | 'stale' | 'broken' | 'unverified';

export interface EntryScope {
  scopeType: ContextScopeType;
  scopeRef?: string | null;
  selector?: IamSelector | null;
}

/**
 * The scope of an entry as a selector: `global` is the empty selector (it
 * constrains nothing, so it covers everything), `cluster` is a selector that
 * constrains the cluster and nothing else.
 *
 * Collapsing the three onto one shape is what lets `covers` and `intersects` be
 * one function each instead of a nine-cell table, and it is exact rather than
 * convenient: those two scopes really are those two selectors.
 */
export function asSelector(scope: EntryScope): IamSelector {
  switch (scope.scopeType) {
    case 'global':
      return {};
    case 'cluster':
      return scope.scopeRef ? { clusterId: scope.scopeRef } : {};
    case 'selector':
      return scope.selector ?? {};
  }
}

const EQUALITY_AXES = [
  'type',
  'kind',
  'clusterId',
  'clusterName',
  'provider',
  'project',
  'owner',
] as const;

type EqualityAxis = (typeof EQUALITY_AXES)[number];

const axis = (s: IamSelector, a: EqualityAxis): string | undefined =>
  s[a] as string | undefined;

/**
 * Does every resource that matches `inner` also match `outer`?
 *
 * Under-approximates: unsure answers `false`. That is the direction that has to
 * be safe, because this is the relation the *restrictive* questions are asked
 * with — may this principal read the reasons behind a level, may they write a
 * rule at it. An under-approximation only ever refuses somebody who could have
 * been allowed; the opposite would hand a tenant the platform's pen.
 */
export function covers(outer: IamSelector, inner: IamSelector): boolean {
  for (const a of EQUALITY_AXES) {
    const o = axis(outer, a);
    if (o !== undefined && axis(inner, a) !== o) return false;
  }
  if (outer.slugs?.length) {
    const within = inner.slugs?.length
      ? inner.slugs.every((s) => outer.slugs?.includes(s))
      : false;
    if (!within) return false;
  }
  if (outer.tags?.length) {
    if (!outer.tags.every((t) => inner.tags?.includes(t))) return false;
  }
  return true;
}

/**
 * Could a single resource match both?
 *
 * Over-approximates: unsure answers `true`. This is the relation the
 * *permissive* question uses — does the local practice reach somebody who acts
 * here — and rule 2 says the failure to avoid is withholding advice. Tags never
 * block, because a resource may carry any set of them.
 */
export function intersects(a: IamSelector, b: IamSelector): boolean {
  for (const ax of EQUALITY_AXES) {
    const x = axis(a, ax);
    const y = axis(b, ax);
    if (x !== undefined && y !== undefined && x !== y) return false;
  }
  if (a.slugs?.length && b.slugs?.length) {
    return a.slugs.some((s) => b.slugs?.includes(s));
  }
  return true;
}

/**
 * The axes that say *where* a resource sits. All three are properties of the
 * cluster it runs on, which is why one placement carries all three.
 */
const PLACEMENT_AXES = ['clusterId', 'clusterName', 'provider'] as const;

/**
 * The axes that say *which* resources a grant follows, wherever they are put.
 * `slugs` and `tags` belong here too and are asked for separately, being lists.
 */
const IDENTITY_AXES = ['type', 'kind', 'project', 'owner'] as const;

/** One place resources actually sit. `null` on an axis means "not recorded". */
export interface Placement {
  clusterId?: string | null;
  clusterName?: string | null;
  provider?: string | null;
}

/** Does this selector constrain where a resource sits? */
export function namesAPlace(s: IamSelector): boolean {
  return PLACEMENT_AXES.some((a) => axis(s, a) !== undefined);
}

/** Does this selector constrain which resources it follows? */
export function followsResources(s: IamSelector): boolean {
  return (
    IDENTITY_AXES.some((a) => axis(s, a) !== undefined) ||
    !!s.slugs?.length ||
    !!s.tags?.length
  );
}

const sitsAt = (p: Placement, target: IamSelector): boolean =>
  PLACEMENT_AXES.every((a) => {
    const want = axis(target, a);
    return want === undefined || want === (p[a] ?? undefined);
  });

/**
 * The permissive reach, asked of a grant whose resources have been located.
 *
 * `intersects` is left exactly as it is. It over-approximates on purpose, and
 * the over-approximation is the safe direction for a *reading*: what is
 * narrowed here is the **question put to it**, not the function.
 *
 * The hole it closes is precise. A grant that names only its owner leaves the
 * cluster axis undefined, so `intersects` — which discards an axis only when
 * both sides declare it and disagree — meets every cluster there is. On an
 * installation with more than one cluster that hands a tenant the local
 * practice of clusters they have nothing on, `scopeRef` and title in the clear.
 *
 * Three conditions, and all three have to hold before anything is refused:
 *
 *  - the placements are **known**. `null` means the question could not be
 *    answered, and an unanswerable question goes back to over-approximating —
 *    that is still the safe side for a reading;
 *  - the entry **names a place**. A global note constrains no placement axis,
 *    so nothing here can touch it: rule 2 says the platform's practice descends
 *    to whoever acts, and it still does, down to the guest;
 *  - the grant **follows resources and does not name a place**. A grant pinned
 *    to a cluster is already exact under `intersects`, and narrowing it by
 *    where its resources sit today would withhold a cluster's practice from its
 *    own operator on the day the cluster is empty. A grant that constrains
 *    nothing follows no resources, so locating them means nothing.
 */
export function reachesFrom(
  grant: IamSelector,
  target: IamSelector,
  placements?: Placement[] | null,
): boolean {
  if (!intersects(grant, target)) return false;
  if (!placements) return true;
  if (!namesAPlace(target)) return true;
  if (namesAPlace(grant) || !followsResources(grant)) return true;
  return placements.some((p) => sitsAt(p, target));
}

/**
 * A grant's reach as a selector, or `null` when the grant reaches no resource
 * at all (`section` scope). Global grants are handled by the caller, which sees
 * them as `globalPermissions` and never as a `ScopedGrant`.
 */
export function grantScope(g: ScopedGrant): IamSelector | null {
  if (g.scopeType === 'section') return null;
  return asSelector({
    scopeType: g.scopeType === 'global' ? 'global' : g.scopeType,
    scopeRef: g.scopeRef,
    selector: g.selector,
  });
}

export interface ReachQuestion {
  scope: EntryScope;
  nature: EntryNature;
  /** The permission the grant must carry for this to be a reach at all. */
  permission: string;
}

/**
 * Does this entry reach this principal?
 *
 * One function, and the only thing the nature changes is which of the two
 * relations above is asked. Nothing here knows about entries, tenants or the
 * demonstration: it is the same access object the fence filters applications
 * with, asked a different question.
 *
 * `placements` is where the principal's resources actually sit, and it is only
 * ever consulted by the permissive half — see {@link reachesFrom}. Omitted or
 * `null` reproduces the behaviour exactly as it was.
 */
export function reachesReader(
  access: PrincipalAccess,
  q: ReachQuestion,
  placements?: Placement[] | null,
): boolean {
  if (access.isAdmin) return true;
  if (access.globalPermissions.has(q.permission)) return true;
  const target = asSelector(q.scope);
  return access.scopedGrants.some((g) => {
    if (!g.permissions.has(q.permission)) return false;
    const scope = grantScope(g);
    if (!scope) return false;
    return q.nature === 'rationale'
      ? covers(scope, target)
      : reachesFrom(scope, target, placements);
  });
}

/**
 * Would locating this principal's resources change any of these answers?
 *
 * Asked before the placements are resolved, because resolving them reads the
 * application inventory and most readers do not need it: an administrator and
 * an instance-wide operator are answered before any grant is looked at, a
 * reader with no place-bound entry in front of them has nothing to narrow, and
 * a grant that already names its cluster is exact without help.
 */
export function needsPlacements(
  access: PrincipalAccess,
  targets: IamSelector[],
  permission: string,
): boolean {
  if (access.isAdmin || access.globalPermissions.has(permission)) return false;
  if (!targets.some(namesAPlace)) return false;
  return access.scopedGrants.some((g) => {
    if (!g.permissions.has(permission)) return false;
    const s = grantScope(g);
    return !!s && followsResources(s) && !namesAPlace(s);
  });
}

/**
 * May this principal write an entry at this scope?
 *
 * Always `covers`, whatever the nature: writing is an act at the level, and a
 * grant that reaches one application inside a cluster has no standing to write
 * the cluster's rule — the entry would reach every other tenant on it.
 */
export function mayWriteAt(
  access: PrincipalAccess,
  scope: EntryScope,
  permission: string,
): boolean {
  if (access.isSandbox) return false;
  if (access.isAdmin) return true;
  if (access.globalPermissions.has(permission)) return true;
  const target = asSelector(scope);
  return access.scopedGrants.some((g) => {
    if (!g.permissions.has(permission)) return false;
    const s = grantScope(g);
    return !!s && covers(s, target);
  });
}
