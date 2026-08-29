import { ProfileManager } from '../profile-manager';
import { askAgent } from './vault-agent';
import { setProfileKey } from './session-key';
import { suppliedProfileKey } from './supplied-key';
import type { ProfileKey } from './vault-crypto';

/**
 * Puts this profile's key where the credential path can read it.
 *
 * Every process that opens a stored credential needs this, and there is more
 * than one kind: an oclif command, which runs it from the init hook, and the
 * detached worker that provisions a cluster, which is spawned by a command but
 * is not one itself. The worker inherits the environment and nothing else — a
 * key held in the parent's memory does not cross the process boundary — so
 * without its own call it reaches the provider with a vault it believes locked.
 */
export async function openProfileKey(
  profile: string = ProfileManager.getActiveProfile(),
): Promise<void> {
  // Deliberately outside the catch: a caller that supplied a key meant it, so a
  // malformed one has to stop the run rather than fall through to a vault that
  // will report itself locked and send whoever is debugging it after the wrong
  // thing entirely.
  const supplied = suppliedProfileKey();

  // Ahead of the agent: an explicit key from the caller is the more specific
  // instruction, and a worker with its own throwaway HOME has no agent to ask.
  if (supplied) {
    setProfileKey(profile, supplied);
    return;
  }

  try {
    const response = await askAgent({ op: 'profile-key', profile });
    if (response?.ok && response.key) {
      setProfileKey(profile, Buffer.from(response.key, 'base64') as ProfileKey);
    }
  } catch {
    // An unreachable agent leaves the vault locked, which the credential path
    // reports in context. It must never stop work that needs no secret.
  }
}
