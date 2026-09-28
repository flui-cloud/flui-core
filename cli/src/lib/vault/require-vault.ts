import { ProfileManager } from '../profile-manager';
import { VaultLockedError, getProfileKey } from './session-key';
import { VaultFile, VaultNotInitialisedError } from './vault-file';

/**
 * Stops a command that is about to create secrets — a cluster's passwords, its
 * SSH key, its encryption key — unless the vault can seal them. Checked before
 * the first provider call, so a refusal never leaves a paid server behind.
 */
export function requireOpenVault(
  profile: string = ProfileManager.getActiveProfile(),
  baseDir: string = ProfileManager.BASE_DIR,
): void {
  if (!new VaultFile(baseDir).exists()) throw new VaultNotInitialisedError();
  if (!getProfileKey(profile)) throw new VaultLockedError(profile);
}
