import * as crypto from 'node:crypto';

/**
 * The format every `*Encrypted` value is stored in: base64 of
 * iv (16 bytes) + authTag (16 bytes) + ciphertext, AES-256-GCM.
 *
 * Kept as plain functions so a process that has no Nest container — the CLI
 * migrating a profile at `vault unlock` — reads and writes exactly what
 * `EncryptionService` does.
 */
const ALGORITHM = 'aes-256-gcm';

export const PLATFORM_KEY_BYTES = 32;

/**
 * Set by the Flui CLI when it decided there is no key it may use (the vault is
 * locked, or not set up yet). The value is the sentence to show whoever then
 * needs a secret; the service stays up so commands that need none still run.
 */
export const ENCRYPTION_KEY_UNAVAILABLE_VAR = 'FLUI_ENCRYPTION_KEY_UNAVAILABLE';

export class EncryptionKeyUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'EncryptionKeyUnavailableError';
  }
}

export function parsePlatformKeyHex(hex: string | undefined): Buffer | null {
  const trimmed = hex?.trim() ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(trimmed)) return null;
  return Buffer.from(trimmed, 'hex');
}

export function sealWithPlatformKey(key: Buffer, plaintext: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

export function openWithPlatformKey(key: Buffer, sealed: string): string {
  const buffer = Buffer.from(sealed, 'base64');
  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    buffer.subarray(0, 16),
  );
  decipher.setAuthTag(buffer.subarray(16, 32));
  return Buffer.concat([
    decipher.update(buffer.subarray(32)),
    decipher.final(),
  ]).toString('utf8');
}

export function opensWithPlatformKey(key: Buffer, sealed: string): boolean {
  try {
    openWithPlatformKey(key, sealed);
    return true;
  } catch {
    return false;
  }
}
