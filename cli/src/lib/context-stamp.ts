import { ProfileManager } from './profile-manager';

/**
 * The label that says which context created a resource at the provider.
 *
 * One provider account holds several installations — a production one, a
 * staging one, someone else's — and until this existed nothing told them apart.
 * A control firewall from a live installation carries the same three labels as
 * one abandoned by a failed run thirty seconds ago, so any cleanup that reasons
 * about "leftover garbage" is reasoning about a resource it cannot identify.
 *
 * The name is a courtesy: it makes the console readable and keeps provider-side
 * uniqueness rules satisfiable. The label is the authority, and it is the only
 * thing a deletion may act on.
 */
export const CONTEXT_LABEL = 'flui-context';

/**
 * The active context, in the shape a provider accepts in a resource name.
 *
 * Contexts admit underscores; Hetzner server names are hostname-shaped and do
 * not. Trimmed to something that leaves room for the rest of a name — a server
 * name is capped at 63 characters and the context is only one segment of it.
 */
export function contextTag(profile?: string): string {
  const raw = profile ?? ProfileManager.getActiveProfile();
  const tag = raw
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 20);
  return tag || 'default';
}

export function contextLabelPair(profile?: string): {
  key: string;
  value: string;
} {
  return { key: CONTEXT_LABEL, value: contextTag(profile) };
}

/**
 * Whether a resource was created by this context.
 *
 * An unstamped resource is never this context's, whatever its name looks like.
 * Everything that existed before the stamp is unstamped, which is exactly the
 * population a sweep must not touch: it was created by an installation that had
 * no way to identify itself, and guessing on its behalf is what this replaces.
 */
export function belongsToContext(
  labels: Record<string, string> | null | undefined,
  profile?: string,
): boolean {
  const stamp = labels?.[CONTEXT_LABEL];
  return !!stamp && stamp === contextTag(profile);
}

/**
 * A resource name that says which context it belongs to.
 *
 * The default context keeps the plain name. A cluster's name is not private
 * bookkeeping — it appears in the address of every application it hosts
 * (`<app>.<cluster>.<zone>`), and a single installation should not have to read
 * `control-cluster-default` in its own URLs. Any other context does say its
 * name, which is where the collision it prevents actually arises: a provider
 * account holding a second installation, whose master would otherwise ask for a
 * server name the first one already took.
 */
export function contextScopedName(base: string, profile?: string): string {
  const tag = contextTag(profile);
  return tag === 'default' ? base : `${base}-${tag}`;
}
