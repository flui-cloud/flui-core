/**
 * Who a hostname may be claimed by.
 *
 * Two questions, both pure, both asked before an endpoint row exists:
 *
 *   - do two host patterns route the same name? Traefik serves whatever the
 *     Ingresses declare, so two objects naming the same host are not a race
 *     between tenants, they are a hijack of whichever one Traefik picks;
 *   - is a name inside a given subdomain? That is how a tenancy's own space is
 *     described, one label deep, exactly as the wildcard certificate that
 *     serves it is.
 *
 * A wildcard covers one label and no more — the same rule Kubernetes Ingress
 * and a `*.` certificate use — so `*.example.test` answers for `a.example.test`
 * and not for `b.a.example.test`.
 */

export function normalizeHost(host: string): string {
  const trimmed = host.trim().toLowerCase();
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

/** `child` is one label under `suffix` — `a.x.test` under `x.test`, not `b.a.x.test`. */
export function isDirectChildOf(child: string, suffix: string): boolean {
  const c = normalizeHost(child);
  const s = normalizeHost(suffix);
  if (!s || c === s) return false;
  if (!c.endsWith(`.${s}`)) return false;
  const label = c.slice(0, c.length - s.length - 1);
  return label.length > 0 && !label.includes('.');
}

/** True when a wildcard host would answer for the given name. */
function wildcardCovers(pattern: string, host: string): boolean {
  if (!pattern.startsWith('*.')) return false;
  return isDirectChildOf(host, pattern.slice(2));
}

/**
 * True when two declared hosts can be served the same request — the same name,
 * or a wildcard that swallows the other.
 */
export function hostsOverlap(a: string, b: string): boolean {
  const left = normalizeHost(a);
  const right = normalizeHost(b);
  if (!left || !right) return false;
  if (left === right) return true;
  return wildcardCovers(left, right) || wildcardCovers(right, left);
}
