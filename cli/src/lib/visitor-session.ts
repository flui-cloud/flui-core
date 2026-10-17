import { ConfigStorage } from './config-storage';

export const INSTALL_FLUI_URL = 'https://flui.cloud/#install';

export const SIGN_IN_REQUIRED_CODE = 'SANDBOX_SIGN_IN_REQUIRED';
export const VISITOR_GONE_CODE = 'VISITOR_GONE';
export const VISITOR_MERGED_CODE = 'VISITOR_MERGED';

const VISITOR_MESSAGES: Record<string, string> = {
  [SIGN_IN_REQUIRED_CODE]: `You are looking around a read-only demo. Install Flui on your own server to do this: ${INSTALL_FLUI_URL}`,
  [VISITOR_GONE_CODE]:
    'Your visit has ended. Start a new one with flui login --try',
  [VISITOR_MERGED_CODE]:
    'This visit now belongs to your account. Sign in with flui login',
};

/** What the CLI says for an error code the API gives a visitor, or null for any other. */
export function visitorErrorMessage(code: unknown): string | null {
  return typeof code === 'string' ? (VISITOR_MESSAGES[code] ?? null) : null;
}

export function errorCodeOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

const VISITOR_PREFERENCE = 'visitorSession';

export interface VisitorSession {
  since: string;
  until: string | null;
}

export function markVisitorSession(
  storage: ConfigStorage,
  until: string | null,
  now = new Date(),
): void {
  storage.setPreference(VISITOR_PREFERENCE, {
    since: now.toISOString(),
    until,
  } satisfies VisitorSession);
}

export function clearVisitorSession(storage: ConfigStorage): void {
  storage.removePreference(VISITOR_PREFERENCE);
}

export function visitorSessionOf(
  storage: ConfigStorage,
): VisitorSession | null {
  const value = storage.getPreference<VisitorSession>(VISITOR_PREFERENCE);
  return value && typeof value === 'object' && value.since ? value : null;
}

export interface PermissionGroup {
  key: string;
  depth: string;
  grantable: boolean;
}

/** The read groups a visitor may put on its key: always named, never an unscoped key. */
export function visitorKeyGroups(groups: PermissionGroup[]): string[] {
  return groups
    .filter((g) => g.grantable && g.depth === 'look')
    .map((g) => g.key);
}
