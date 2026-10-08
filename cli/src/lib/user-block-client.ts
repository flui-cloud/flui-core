import { ApiClient } from './api-client';

export interface BlockState {
  id: string;
  email: string;
  blockedAt: string | null;
  blockedReason: string | null;
}

/** An email is looked up; anything else is taken as an id the API understands. */
export async function resolveUserId(
  api: ApiClient,
  ref: string,
): Promise<string> {
  if (!ref.includes('@')) return ref;
  const found = await api.get<Array<{ id: string; email: string }>>(
    `/auth/users?search=${encodeURIComponent(ref)}`,
  );
  const exact = found.filter(
    (u) => u.email?.toLowerCase() === ref.toLowerCase(),
  );
  if (exact.length !== 1) {
    throw new Error(
      exact.length === 0
        ? `No person with the address ${ref}`
        : `More than one person matches ${ref}`,
    );
  }
  return exact[0].id;
}

export async function setBlocked(
  api: ApiClient,
  ref: string,
  blocked: boolean,
  reason?: string,
): Promise<BlockState> {
  const id = await resolveUserId(api, ref);
  return api.post<BlockState>(
    `/auth/users/${encodeURIComponent(id)}/${blocked ? 'block' : 'unblock'}`,
    blocked && reason ? { reason } : {},
  );
}
