/**
 * Who put a thing here — read from the declaration, not inferred from a blank.
 *
 * The bootstrap has labelled every resource it creates for three months:
 * `flui.cloud/owner-kind` says whether the platform or a person put it there,
 * `flui.cloud/owner-id` says which side declares it (`flui-core`). Nothing in
 * this codebase read either one. Discovery stood in front of those labels,
 * found the resource, and wrote `userId = null` — turning a declaration into an
 * absence.
 *
 * That absence then had to do two jobs at once: *the platform put this here*
 * (zitadel, the system Postgres, redis, grafana, loki, the metrics stack) and
 * *an API key installed this and recorded no owner* (Umami's databases,
 * Penpot's Postgres and valkey). The bootstrap separates them; the database did
 * not. Reading the label back into the row is what separates them here, and it
 * is what turns the second set into a visible registration defect instead of a
 * permission.
 */

export const OWNER_KIND_LABEL = 'flui.cloud/owner-kind';
export const OWNER_ID_LABEL = 'flui.cloud/owner-id';

/**
 * The two readings a row may carry. Deliberately narrower than the label's
 * vocabulary: the bootstrap also writes `owner-kind: application` on the
 * ConfigMaps and Secrets that belong to a workload, which says which *app* owns
 * a resource, not who put the app here. That value is not a provenance and is
 * read as no declaration at all — the alternative is inventing a third meaning
 * for a word somebody else already spends.
 */
export type AppOwnerKind = 'platform' | 'user';

const DECLARED_OWNER_KINDS: ReadonlySet<string> = new Set(['platform', 'user']);

export interface AppProvenance {
  ownerKind: AppOwnerKind | null;
  ownerRef: string | null;
}

export const NO_PROVENANCE: AppProvenance = { ownerKind: null, ownerRef: null };

/** The subset of an application row this module reasons over. */
export interface ProvenanceCandidate {
  userId?: string | null;
  ownerKind?: string | null;
  ownerRef?: string | null;
}

/**
 * The provenance a Kubernetes resource declares about itself.
 *
 * Returns nothing rather than guessing: a resource that carries no label is
 * undeclared, and an undeclared resource must not be promoted to `platform` by
 * the mere fact that discovery is the code path reading it. Discovery finds
 * catalogued system apps, but the day somebody points it at anything else the
 * silent promotion would be the bug this whole change exists to remove.
 */
export function readDeclaredProvenance(resource: unknown): AppProvenance {
  const labels = (
    resource as { metadata?: { labels?: Record<string, string> } } | null
  )?.metadata?.labels;
  if (!labels) return NO_PROVENANCE;

  const kind = labels[OWNER_KIND_LABEL];
  if (!kind || !DECLARED_OWNER_KINDS.has(kind)) return NO_PROVENANCE;

  return {
    ownerKind: kind as AppOwnerKind,
    ownerRef: labels[OWNER_ID_LABEL] ?? null,
  };
}

/** True when the row says the platform put this here. */
export function isPlatformOwned(app: ProvenanceCandidate | null): boolean {
  return app?.ownerKind === 'platform';
}

/**
 * A row with no owner **and** no declaration.
 *
 * Not a category of application: a record that is missing something. Before the
 * label was read, this state was indistinguishable from a platform component,
 * and the rule that covered both — "unowned means administrators only" — was a
 * safety net over two different facts. Named here so a caller can refuse it
 * *and say why*, rather than quietly folding it in with the platform's own.
 */
export function isUnattributed(app: ProvenanceCandidate | null): boolean {
  return !!app && !app.userId && !app.ownerKind;
}
