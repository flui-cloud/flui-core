import { stripTrailingSlashes } from '../../../common/utils/url.util';

/** `/`, `/api` — the form the gateway compiles a route's path to. */
export function normalizeRoutePath(path: string | null | undefined): string {
  if (!path || path === '/') return '/';
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return stripTrailingSlashes(withSlash) || '/';
}

interface Owner {
  projectId?: string | null;
  userId?: string | null;
}

/**
 * Whether two applications may answer on the same host.
 *
 * A host is the project's: its routes are one site with several parts. An
 * application outside any project shares only with its owner's other
 * applications outside any project — otherwise any user could graft a path
 * onto a host somebody else published.
 */
export function mayShareHost(a: Owner, b: Owner): boolean {
  if (a.projectId || b.projectId) return a.projectId === b.projectId;
  return !!a.userId && a.userId === b.userId;
}
