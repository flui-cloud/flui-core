/**
 * Keeping guest applications out of search engines.
 *
 * A public sub-domain that anyone can point real content at is a gift to
 * phishing and to parasite SEO. The tenancy dies in a day, but a search index
 * outlives it, and what stays behind is our domain vouching for a stranger's
 * page. The header is added at the ingress, not asked of the application, since
 * whatever a guest installs will not do it for us.
 */
export const SANDBOX_NOINDEX_HEADER = {
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
};

export const SANDBOX_NOINDEX_MIDDLEWARE_NAME = 'sandbox-noindex';

export function sandboxNoindexMiddlewareRef(namespace: string): string {
  return `${namespace}-${SANDBOX_NOINDEX_MIDDLEWARE_NAME}@kubernetescrd`;
}

export function buildNoindexMiddleware(namespace: string): string {
  return `apiVersion: traefik.io/v1alpha1
kind: Middleware
metadata:
  name: ${SANDBOX_NOINDEX_MIDDLEWARE_NAME}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: flui
    flui.cloud/sandbox: "true"
spec:
  headers:
    customResponseHeaders:
      X-Robots-Tag: "${SANDBOX_NOINDEX_HEADER['X-Robots-Tag']}"
`;
}

/**
 * Served at the apex of the guest domain. `Disallow: /` on the wildcard host is
 * the half of the promise that covers crawlers which never fetch a page before
 * deciding to index the host.
 */
export const SANDBOX_ROBOTS_TXT = `User-agent: *
Disallow: /
`;
