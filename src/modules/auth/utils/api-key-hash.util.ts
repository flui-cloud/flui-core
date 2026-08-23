import { createHash } from 'node:crypto';

/** Every key Flui mints carries it, and the CLI matches on it. */
export const API_KEY_PREFIX = 'flui_';

/**
 * What the `api_keys` table holds, in place of the credential itself.
 *
 * Until now the column held `flui_<uuid>` verbatim, so a dump of the database
 * was a dump of every live credential on the installation — no decryption, no
 * further step. Storing the digest makes the row useless to whoever reads it,
 * while the lookup stays one indexed equality on the hash of what was
 * presented.
 *
 * SHA-256 and not a password KDF, deliberately. bcrypt/argon exist to make
 * guessing a human-chosen secret expensive; the thing being hashed here is 122
 * bits of `crypto.randomUUID()`, which is not guessable at any cost, and a slow
 * KDF cannot be used with an indexed equality lookup — every request would
 * become a table scan with one derivation per row. The property that matters is
 * "the stored value cannot be used as a credential", and a fast digest of a
 * high-entropy random token has it.
 *
 * No salt, for the same reason and one more: a per-row salt would forbid
 * looking a key up by its hash, which is the entire lookup path.
 */
export function hashApiKey(presented: string): string {
  return createHash('sha256').update(presented.trim(), 'utf8').digest('hex');
}
