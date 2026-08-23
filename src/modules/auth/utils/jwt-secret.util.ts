import { Logger } from '@nestjs/common';
import { randomBytes } from 'node:crypto';

/** The published default that made every self-hosted install share one signing key. */
export const JWT_SECRET_PLACEHOLDER = 'changeme';

const logger = new Logger('JwtSecret');

/**
 * Per-process, and deliberately not stable across restarts. Only reached in a
 * mode where nothing is signed with it that has to survive a restart.
 */
let ephemeral: string | undefined;

export interface JwtSecretSource {
  get<T = string>(key: string): T | undefined;
}

/**
 * The signing key for everything Flui issues itself, resolved in one place.
 *
 * It used to be `config.get('JWT_SECRET', 'changeme')`, written out four times.
 * A default that ships in the source is not a default: it is a key every
 * installation shares with every reader of the repository, and it signs the
 * sessions of `AUTH_MODE=local` — the mode a self-hosted install gets unless it
 * asks for otherwise.
 *
 * So in `local` the absence is fatal and the API refuses to start. The
 * installer already refuses (`k3s-master-init.sh`), but the installer is not
 * the only way this is deployed, and the guarantee belongs to the product.
 *
 * In the other modes sessions come from the identity provider and this key
 * signs only side channels (object-share links). Refusing there would brick
 * every existing OIDC install that never set the variable, so the absence is
 * survivable — but never with the published string. A per-process random value
 * is used instead: share links stop surviving a restart, which is a visible
 * inconvenience, where a key anyone can read is an invisible one.
 */
export function resolveJwtSecret(config: JwtSecretSource): string {
  const authMode = (config.get<string>('AUTH_MODE') ?? '').trim().toLowerCase();
  const configured = (config.get<string>('JWT_SECRET') ?? '').trim();
  const usable = configured && configured !== JWT_SECRET_PLACEHOLDER;

  if (usable) return configured;

  if (authMode === 'local') {
    throw new Error(
      configured
        ? `JWT_SECRET is set to the placeholder '${JWT_SECRET_PLACEHOLDER}'. In AUTH_MODE=local this key signs every session on this installation, so it must be a secret of your own. Refusing to start.`
        : 'JWT_SECRET is not set. In AUTH_MODE=local this key signs every session on this installation, and there is no safe default for it. Set it to a random value (for example `openssl rand -hex 32`) and start again. Refusing to start.',
    );
  }

  if (!ephemeral) {
    ephemeral = randomBytes(32).toString('hex');
    logger.warn(
      `JWT_SECRET is ${configured ? "set to the placeholder 'changeme'" : 'not set'} (AUTH_MODE=${authMode || 'unset'}). ` +
        'Falling back to a random per-process key: object share links will not survive a restart. Set JWT_SECRET to keep them valid.',
    );
  }
  return ephemeral;
}
