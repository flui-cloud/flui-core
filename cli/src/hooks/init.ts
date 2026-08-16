import { Hook } from '@oclif/core';
import { ProfileManager } from '../lib/profile-manager';
import { askAgent } from '../lib/vault/vault-agent';
import { setProfileKey } from '../lib/vault/session-key';
import { suppliedProfileKey } from '../lib/vault/supplied-key';
import type { ProfileKey } from '../lib/vault/vault-crypto';

/**
 * Commands that must not touch the agent.
 *
 * `vault agent` *is* the agent, and `vault unlock` is what starts it — asking
 * for a key at that point would either deadlock or race the socket into
 * existence. `vault init` runs before any vault exists at all.
 */
const SKIP = new Set([
  'vault:agent',
  'vault:unlock',
  'vault:init',
  'vault:lock',
]);

/**
 * Fetches this profile's key from the agent before the command runs.
 *
 * This is the one asynchronous moment in the whole arrangement. Everything that
 * reads a stored credential afterwards does so synchronously, which is why the
 * eighty-odd call sites across the CLI did not have to change.
 *
 * A locked vault is not an error here. Most commands never touch a credential,
 * and failing at startup would make `flui env status` demand a passphrase it
 * has no use for. The command that actually needs one fails with a message
 * naming `flui vault unlock`.
 */
const hook: Hook<'init'> = async function (opts) {
  const id = opts.id ?? '';
  if (SKIP.has(id)) return;

  // Deliberately outside the catch below: a caller that supplied a key meant
  // it, so a malformed one has to stop the command rather than fall through to
  // a vault that will report itself locked and send whoever is debugging it
  // after the wrong thing entirely.
  const supplied = suppliedProfileKey();

  try {
    const profile = ProfileManager.getActiveProfile();

    // Ahead of the agent: an explicit key from the caller is the more specific
    // instruction, and a worker with its own throwaway HOME has no agent to ask.
    if (supplied) {
      setProfileKey(profile, supplied);
      return;
    }

    const response = await askAgent({ op: 'profile-key', profile });
    if (response?.ok && response.key) {
      setProfileKey(profile, Buffer.from(response.key, 'base64') as ProfileKey);
    }
  } catch {
    // An unreachable agent leaves the vault locked, which the credential path
    // reports in context. It must never stop a command that needs no secret.
  }
};

export default hook;
