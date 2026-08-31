import { randomBytes, randomInt } from 'node:crypto';

export type RandomSecretFormat = 'base64url' | 'hex';

const ALPHANUMERIC =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/**
 * A cryptographically random string, drawn character by character from the
 * given alphabet — not an encoding of a fixed number of bytes, so `length` is
 * exactly the length of the result. Omitted `format` draws from [A-Za-z0-9],
 * matching `valueFrom.generate.format` in the Application spec.
 */
export function generateRandomSecret(
  length: number,
  format?: RandomSecretFormat,
): string {
  if (length < 8 || length > 256) {
    throw new Error(
      `Invalid secret length ${length}: must be between 8 and 256`,
    );
  }
  if (format === 'hex') {
    // Hex uses 2 chars per byte, so ceil(length/2) bytes are enough to
    // produce at least `length` hex chars; slice to the exact length.
    const bytes = randomBytes(Math.ceil(length / 2));
    return bytes.toString('hex').slice(0, length);
  }
  if (format === 'base64url') {
    const bytes = randomBytes(length);
    return bytes.toString('base64url').slice(0, length);
  }
  let out = '';
  for (let i = 0; i < length; i++) {
    out += ALPHANUMERIC[randomInt(ALPHANUMERIC.length)];
  }
  return out;
}
