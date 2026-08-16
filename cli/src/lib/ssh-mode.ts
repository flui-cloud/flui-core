/**
 * How a cluster is reached over SSH while it is being built, and what is left
 * behind once it is.
 *
 * `ca` is the operator default: this machine's SSH certificate authority is
 * enrolled on every node at cloud-init, and stays there. The operator can open
 * a shell whenever they want, for as long as the cluster exists.
 *
 * `ephemeral-key` is what a cluster provisioned on someone else's behalf needs.
 * No certificate authority is created or enrolled — the only credential is a
 * throwaway keypair minted for this run, and it is revoked on the nodes and
 * deleted at the provider before the run ends. What remains is a cluster with
 * an empty `trusted_user_ca_keys` and no authorized key: nothing can open a
 * shell on it, including whoever built it. The owner opens that door themselves
 * with `flui env adopt`, using a CA generated on their own machine.
 */
export type SshMode = 'ca' | 'ephemeral-key';

export const SSH_MODES: readonly SshMode[] = ['ca', 'ephemeral-key'];

export function resolveSshMode(metadata: unknown): SshMode {
  const declared = (metadata as { sshMode?: unknown } | null)?.sshMode;
  return declared === 'ephemeral-key' ? 'ephemeral-key' : 'ca';
}

/**
 * Removes one public key from a user's `authorized_keys`, matching on the key
 * body rather than the whole line — the comment field is rewritten by cloud-init
 * on some images, so matching the full line would silently no-op and leave the
 * key in place while reporting success.
 *
 * Writes through a temporary file and moves it into position, so an interrupted
 * run cannot leave a truncated `authorized_keys` and lock the account out.
 */
export function revokeAuthorizedKeyCommand(
  publicKey: string,
  user = 'root',
): string {
  const body = publicKey.trim().split(/\s+/)[1];
  if (!body) {
    throw new Error('Not an SSH public key: no key body to match on.');
  }

  const home = user === 'root' ? '/root' : `/home/${user}`;
  const file = `${home}/.ssh/authorized_keys`;

  return [
    `if [ -f ${file} ]; then`,
    `  grep -v -F '${body}' ${file} > ${file}.pruned || true;`,
    `  chmod 600 ${file}.pruned;`,
    `  chown ${user}: ${file}.pruned;`,
    `  mv ${file}.pruned ${file};`,
    `fi`,
  ].join(' ');
}
