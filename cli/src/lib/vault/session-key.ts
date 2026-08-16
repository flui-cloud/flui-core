import type { ProfileKey } from './vault-crypto';

/**
 * The profile key for the life of this command.
 *
 * Fetched once from the agent before a command runs, then read synchronously by
 * everything that touches a stored credential. Without this, every call site
 * that reads a token would have to become asynchronous to talk to the agent —
 * eighty-odd of them across the CLI, changed for no benefit, since the key is
 * needed in this process either way.
 *
 * Process-local and deliberately not exported as a value: it goes away when the
 * command exits.
 */
const keys = new Map<string, ProfileKey>();

export function setProfileKey(profile: string, key: ProfileKey): void {
  keys.set(profile, key);
}

export function getProfileKey(profile: string): ProfileKey | null {
  return keys.get(profile) ?? null;
}

export function forgetProfileKeys(): void {
  for (const key of keys.values()) key.fill(0);
  keys.clear();
}

export class VaultLockedError extends Error {
  constructor(profile: string) {
    super(
      `The vault is locked, so the credentials for profile "${profile}" cannot be opened.\n` +
        '  Unlock it with:  flui vault unlock',
    );
    this.name = 'VaultLockedError';
  }
}
