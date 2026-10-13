import { PermissionGroup, visitorKeyGroups } from './visitor-session';

type Fetch = typeof fetch;

export const NO_VISITOR_ENTRANCE =
  'This instance has no visitor entrance: its demo does not take visitors. Sign in with flui login instead.';

async function bodyOf(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function messageOf(body: Record<string, unknown>, status: number): string {
  const message = body['message'];
  if (typeof message === 'string' && message) return message;
  if (Array.isArray(message) && message.length) return message.join('; ');
  return `HTTP ${status}`;
}

/** A single-use ticket into the visitors' sign-in, passed on as `login_hint`. */
export async function admitCliVisitor(
  apiUrl: string,
  fetchImpl: Fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(`${apiUrl}/sandbox/visitor/admission`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cli: true }),
  });
  const body = await bodyOf(res);
  if (!res.ok) throw new Error(messageOf(body, res.status));
  const nonce = body['nonce'];
  if (typeof nonce !== 'string' || !nonce) {
    throw new Error('The demo did not hand out a visitor ticket.');
  }
  return nonce;
}

export interface VisitorKey {
  id: string;
  name: string;
  key: string;
  expiresAt: string | null;
  groups: string[];
}

/**
 * The visitor's key names its read groups. The API would refuse an unscoped
 * one anyway, and clamps the expiry to the end of the visit.
 */
export async function mintVisitorKey(
  apiUrl: string,
  accessToken: string,
  name: string,
  fetchImpl: Fetch = fetch,
): Promise<VisitorKey> {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };
  const groupsRes = await fetchImpl(`${apiUrl}/auth/api-key-groups`, {
    headers,
  });
  const groupsBody = (await groupsRes.json().catch(() => null)) as unknown;
  if (!groupsRes.ok || !Array.isArray(groupsBody)) {
    throw new Error(
      messageOf(
        (groupsBody ?? {}) as Record<string, unknown>,
        groupsRes.status,
      ),
    );
  }
  const groups = visitorKeyGroups(groupsBody as PermissionGroup[]);
  if (groups.length === 0) {
    throw new Error('This visit has no read access to put on a key.');
  }
  const res = await fetchImpl(`${apiUrl}/auth/api-keys`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, groups }),
  });
  const body = await bodyOf(res);
  if (!res.ok) throw new Error(messageOf(body, res.status));
  return {
    id: textOf(body['id']),
    name: textOf(body['name']),
    key: textOf(body['key']),
    expiresAt: typeof body['expiresAt'] === 'string' ? body['expiresAt'] : null,
    groups,
  };
}
