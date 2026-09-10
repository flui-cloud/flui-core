import { ApiClient } from './api-client';

/** A repository as `GET /repositories` lists it back. */
export interface ConnectedRepository {
  id: string;
  owner: string;
  repositoryName: string;
  repositoryFullName: string;
  defaultBranch: string;
  htmlUrl?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `owner/repo` from `owner/repo`, a GitHub URL, or a `.git` suffix. */
export function toOwnerRepo(repository: string): string {
  const trimmed = repository.trim().replace(/\.git$/, '');
  if (!/^https?:\/\//i.test(trimmed)) return trimmed.replace(/^\/|\/$/g, '');
  try {
    const parts = new URL(trimmed).pathname.split('/').filter(Boolean);
    return parts.slice(0, 2).join('/');
  } catch {
    return trimmed;
  }
}

/**
 * The connected repository the map routes take, from what a person types.
 *
 * The routes are keyed by Flui's own id, which nobody has memorised — so an id
 * is passed through and anything else is looked up in the repositories this
 * account has actually connected. A miss is reported as "not connected yet",
 * which is a different problem from "does not exist" and has a different
 * remedy.
 */
export async function resolveConnectedRepository(
  api: ApiClient,
  repository: string,
): Promise<ConnectedRepository> {
  const connected = await api.get<ConnectedRepository[]>('/repositories');
  const raw = repository.trim();
  const match = UUID.test(raw)
    ? connected.find((repo) => repo.id === raw)
    : connected.find(
        (repo) =>
          repo.repositoryFullName?.toLowerCase() ===
          toOwnerRepo(raw).toLowerCase(),
      );
  if (match) return match;

  const known = connected
    .map((repo) => repo.repositoryFullName)
    .filter(Boolean);
  throw new Error(
    `"${raw}" is not connected to this Flui installation.\n` +
      (known.length
        ? `  Connected: ${known.join(', ')}\n`
        : '  No repositories are connected.\n') +
      `  Connect it with \`flui repo connect ${UUID.test(raw) ? '<owner/repo>' : toOwnerRepo(raw)}\`.`,
  );
}
