/**
 * The name a tenancy publishes under, and the certificate that has to exist
 * for it to be reachable over TLS.
 *
 * Today every application on a cluster is named `<slug>.<cluster>.<zone>`, so
 * a sandbox guest and the instance's own operators draw from one flat pool of
 * labels: whoever asks for `api` first gets it, and the wildcard certificate in
 * front of them all — `*.<cluster>.<zone>` — answers for every one of those
 * names indiscriminately. A tenancy of its own means one label more:
 *
 *     <slug>.<tenancy>.<cluster>.<zone>
 *
 * and a certificate that reaches exactly that far, `*.<tenancy>.<cluster>.<zone>`.
 *
 * **A TLS wildcard covers one label and no more.** That is not a limit of this
 * code, it is what `*.` means to every browser and to ACME: there is no
 * certificate shape that covers two levels at once. So each tenancy needs its
 * *own* certificate — the existing one cannot be widened to cover them — and
 * `<slug>` has to sit directly under `<tenancy>`, never deeper. Every function
 * here refuses rather than produces a name the certificate would not cover.
 */

/** A DNS label: 63 octets, letters/digits/hyphen, never starting or ending on one. */
export const DNS_LABEL_MAX = 63;

/** A hostname: 253 characters in its textual form. */
export const FQDN_MAX = 253;

/**
 * The prefix `buildUserNamespace` puts on every namespace it derives. Dropped
 * from the public name because it says nothing to the person reading the
 * address bar, and because every namespace carries it — so dropping it keeps
 * the mapping one-to-one.
 */
const NAMESPACE_PREFIX = 'user-';

/** Lowercase, no trailing dot. The form every comparison here is made in. */
export function normalizeName(name: string): string {
  const trimmed = name.trim().toLowerCase();
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

/**
 * Written as a scan rather than as `/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/`: the
 * pattern is the readable way to say it and also the shape this project has
 * already had to remove once for backtracking. A loop cannot be made to run
 * long by its input.
 */
export function isValidLabel(label: string): boolean {
  if (label.length === 0 || label.length > DNS_LABEL_MAX) return false;
  if (label.startsWith('-') || label.endsWith('-')) return false;
  for (const ch of label) {
    const allowed =
      (ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || ch === '-';
    if (!allowed) return false;
  }
  return true;
}

/**
 * The single label a tenancy is known by in a hostname, from the namespace it
 * owns. Null when the namespace cannot be one — an empty result, a label too
 * long, or characters a hostname cannot carry. A tenancy whose namespace does
 * not reduce to a label simply does not get a subdomain; it keeps the shared
 * name, which is the behaviour of every tenancy today.
 */
export function tenancyLabel(namespace: string): string | null {
  const normalized = normalizeName(namespace);
  const stripped = normalized.startsWith(NAMESPACE_PREFIX)
    ? normalized.slice(NAMESPACE_PREFIX.length)
    : normalized;
  return isValidLabel(stripped) ? stripped : null;
}

/**
 * `<tenancy>.<cluster>.<zone>` — the space a tenancy owns, and the scope its
 * wildcard certificate is issued for. Null when any part of it is not a
 * hostname, because a subdomain that cannot be certified is worse than no
 * subdomain at all.
 */
export function buildTenancySubdomain(input: {
  namespace: string;
  clusterName: string;
  zoneName: string;
}): string | null {
  const label = tenancyLabel(input.namespace);
  if (!label) return null;

  const cluster = normalizeName(input.clusterName);
  const zone = normalizeName(input.zoneName);
  if (!cluster || !zone) return null;
  if (!cluster.split('.').every(isValidLabel)) return null;
  if (!zone.split('.').every(isValidLabel)) return null;

  const subdomain = `${label}.${cluster}.${zone}`;
  // One label of headroom, or the subdomain exists and nothing can be published
  // under it — a certificate for a scope no name fits inside is wasted issuance.
  return subdomain.length + 2 <= FQDN_MAX ? subdomain : null;
}

/** `*.<tenancy>.<cluster>.<zone>` — the one dnsName of the tenancy's certificate. */
export function tenancyWildcardHost(subdomain: string): string {
  return `*.${normalizeName(subdomain)}`;
}

/**
 * `<slug>.<tenancy>.<cluster>.<zone>`, or null when the result would not be a
 * name the tenancy's certificate covers: a slug that is not a single label
 * (`a.b` would land two levels down, outside the wildcard) or a hostname past
 * the length a resolver accepts.
 */
export function buildTenancyFqdn(
  slug: string,
  subdomain: string,
): string | null {
  const label = normalizeName(slug);
  if (!isValidLabel(label)) return null;

  const scope = normalizeName(subdomain);
  if (!scope) return null;

  const fqdn = `${label}.${scope}`;
  return fqdn.length <= FQDN_MAX ? fqdn : null;
}

/**
 * True when `host` is a name the tenancy's own wildcard certificate covers:
 * exactly one label under the subdomain, and not the wildcard itself.
 *
 * `*.<tenancy>...` is refused even though it is syntactically one label under:
 * it is every name in the tenancy at once, including ones nothing has claimed
 * yet, which is not what "publish one application" means.
 */
export function isInsideTenancySubdomain(
  host: string,
  subdomain: string,
): boolean {
  const name = normalizeName(host);
  const scope = normalizeName(subdomain);
  if (!name || !scope || name === scope) return false;
  if (name.startsWith('*.')) return false;
  if (!name.endsWith(`.${scope}`)) return false;
  const label = name.slice(0, name.length - scope.length - 1);
  return isValidLabel(label);
}
