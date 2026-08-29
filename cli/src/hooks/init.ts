import { Hook } from '@oclif/core';
import { openProfileKey } from '../lib/vault/open-profile-key';

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

  await openProfileKey();
};

export default hook;
