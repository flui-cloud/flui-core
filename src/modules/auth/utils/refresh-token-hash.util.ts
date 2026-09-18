import { createHash } from 'node:crypto';

/**
 * What the `refresh_tokens` table holds, in place of the token itself.
 *
 * Same reasoning as {@link ../utils/api-key-hash.util#hashApiKey}, which this
 * deliberately does not reuse: the two credentials are unrelated and a shared
 * helper would make a change made for one silently apply to the other. A
 * database dump used to hand the reader a live seven-day session for every
 * local account; the digest makes the row useless while the lookup stays one
 * indexed equality.
 */
export function hashRefreshToken(presented: string): string {
  return createHash('sha256').update(presented.trim(), 'utf8').digest('hex');
}
