import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

const logger = new Logger('MaskModeSalt');

/** Per-process and deliberately not stable across restarts: nothing salted with it has to survive one. */
let ephemeral: string | undefined;

export interface MaskSaltSource {
  get<T = string>(key: string): T | undefined;
}

/**
 * The HMAC key every masked network-identifier and tenant-identity value is
 * salted with. Unset in most self-hosted installs and never fatal — only
 * cross-restart stability of the fakes changes — so it falls back to a random
 * per-process value with a one-time warning instead of refusing to start.
 */
export function resolveMaskSaltSecret(config: MaskSaltSource): string {
  const configured = (config.get<string>('MASK_MODE_SALT_SECRET') ?? '').trim();
  if (configured) return configured;

  if (!ephemeral) {
    ephemeral = randomBytes(32).toString('hex');
    logger.warn(
      'MASK_MODE_SALT_SECRET is not set. Falling back to a random per-process key: ' +
        'masked network-identifier/tenant-identity values will not stay stable across ' +
        'a restart (the same real value will map to a different fake one). Set ' +
        'MASK_MODE_SALT_SECRET to keep them stable.',
    );
  }
  return ephemeral;
}
