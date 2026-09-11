import { PREFERENCES, isPreferenceKey } from './preferences-schema';

/**
 * Cloud provider keys recognized by `flui config set/get/remove`.
 * Kept in sync with the prompts/credential logic; extend here when adding a new provider.
 */
export const SUPPORTED_PROVIDERS = ['hetzner', 'scaleway', 'ovh'] as const;
export type SupportedProvider = (typeof SUPPORTED_PROVIDERS)[number];

export const SYSTEM_KEYS = ['api-url'] as const;
export type SystemKey = (typeof SYSTEM_KEYS)[number];

export type KeyKind = 'preference' | 'provider' | 'system' | 'unknown';

/**
 * Decide which storage area (preferences vs encrypted token vault) a `flui config` command
 * should target, based purely on the key the user passed in.
 *
 * The dispatch is intentionally schema-driven so adding a new preference or provider does
 * not require touching the user-facing commands.
 */
export function classifyKey(key: string): KeyKind {
  if (isPreferenceKey(key)) return 'preference';
  if ((SYSTEM_KEYS as readonly string[]).includes(key.toLowerCase())) {
    return 'system';
  }
  if ((SUPPORTED_PROVIDERS as readonly string[]).includes(key.toLowerCase())) {
    return 'provider';
  }
  return 'unknown';
}

/**
 * Multi-line description of every key the user can target — shown in error messages
 * when an unknown key is passed to `flui config set/get/remove`.
 */
export function formatKnownKeys(): string {
  const prefs = Object.values(PREFERENCES)
    .map((p) => `  - ${p.key} (preference) — ${p.description}`)
    .join('\n');
  const providers = SUPPORTED_PROVIDERS.map((p) => {
    const isCompound = p === 'scaleway' || p === 'ovh';
    return `  - ${p} (${isCompound ? 'access key + secret key' : 'provider token'})`;
  }).join('\n');
  const system = SYSTEM_KEYS.map((k) => `  - ${k} (system override)`).join(
    '\n',
  );
  return `Preferences:\n${prefs}\n\nProviders:\n${providers}\n\nSystem:\n${system}`;
}
