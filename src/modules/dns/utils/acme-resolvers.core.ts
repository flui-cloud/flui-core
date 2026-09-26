/**
 * cert-manager checks a challenge through a resolver before telling the CA to
 * look. The cluster's own resolver, and the provider's behind it, can keep a
 * just-created name cached as missing for the zone's negative TTL (an hour on
 * Hetzner), so the check is pinned to public resolvers. New installs already
 * pin them; clusters installed before that are brought in line here.
 */

export const ACME_PUBLIC_NAMESERVERS = '1.1.1.1:53,8.8.8.8:53';

const FLAGS = {
  dns01: '--dns01-recursive-nameservers=',
  dns01Only: '--dns01-recursive-nameservers-only',
  http01: '--acme-http01-solver-nameservers=',
} as const;

export interface AcmeResolverState {
  pinned: boolean;
  nameservers: string | null;
  /** The whole argument list with what is missing added; null when nothing is. */
  nextArgs: string[] | null;
}

export function acmeResolverState(
  args: string[],
  nameservers = ACME_PUBLIC_NAMESERVERS,
): AcmeResolverState {
  const has = (prefix: string) => args.some((a) => a.startsWith(prefix));
  const missing: string[] = [];
  if (!has(FLAGS.dns01)) missing.push(`${FLAGS.dns01}${nameservers}`);
  if (!args.includes(FLAGS.dns01Only)) missing.push(FLAGS.dns01Only);
  if (!has(FLAGS.http01)) missing.push(`${FLAGS.http01}${nameservers}`);

  const current = args
    .find((a) => a.startsWith(FLAGS.http01))
    ?.slice(FLAGS.http01.length);
  return {
    pinned: missing.length === 0,
    nameservers: missing.length === 0 ? (current ?? null) : null,
    nextArgs: missing.length ? [...args, ...missing] : null,
  };
}

export function acmeResolverSentence(
  state: { pinned: boolean; nameservers: string | null } | null,
): string {
  if (!state)
    return 'Could not read how cert-manager checks names on this cluster.';
  return state.pinned
    ? `cert-manager checks names through public resolvers (${state.nameservers ?? 'set'}).`
    : "cert-manager checks names through the cluster's own resolver, which can keep a new name cached as missing for up to an hour.";
}
