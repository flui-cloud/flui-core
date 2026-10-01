import { hkdfSync } from 'node:crypto';

/**
 * Application backups written through rclone reach the bucket through rclone's
 * `crypt` backend, keyed from the destination's own passphrase.
 *
 * Names are left readable (`filename_encryption = off`): the API lists, prunes
 * and retires these objects with the S3 SDK, by name, and every name in these
 * layouts is Flui's own — labels, instants, log numbers, application ids.
 * What crypt adds instead is the `.bin` suffix, which is also how an encrypted
 * object is told from a plaintext one written before this existed.
 */
export const RCLONE_CRYPT_CIPHER = 'rclone-crypt-v1';
export const CRYPT_REMOTE = 'flui_crypt';
export const PLAIN_REMOTE = 'flui';
export const CRYPT_SUFFIX = '.bin';

export interface CryptPasswords {
  password: string;
  password2: string;
}

/**
 * Both crypt secrets from the passphrase, so a restore recomputes them from
 * the same sealed value the backup used and nothing else is stored.
 */
export function deriveCryptPasswords(passphrase: string): CryptPasswords {
  if (!passphrase) throw new Error('A backup passphrase is required');
  const derive = (info: string) =>
    Buffer.from(
      hkdfSync('sha256', passphrase, 'flui/rclone-crypt/v1', info, 32),
    ).toString('base64url');
  return { password: derive('password'), password2: derive('password2') };
}

export function cryptEnv(
  passwords: CryptPasswords,
  prefix = 'FLUI_CRYPT_',
): Record<string, string> {
  return {
    [`${prefix}PASSWORD`]: passwords.password,
    [`${prefix}PASSWORD2`]: passwords.password2,
  };
}

/**
 * Shell that turns the two derived secrets into the `flui_crypt` remote.
 *
 * rclone only accepts obscured passwords from its environment, so they are
 * obscured inside the pod, from stdin, and never appear in a command line or
 * a manifest. A remote named `flui_crypt:` with no such section fails every
 * call, so a job that was meant to encrypt cannot fall back to plaintext.
 */
export function cryptSetupScript(opts?: {
  rclone?: string;
  envPrefix?: string;
  onFailure?: string;
}): string {
  const rclone = opts?.rclone ?? 'rclone';
  const pw = `${opts?.envPrefix ?? 'FLUI_CRYPT_'}PASSWORD`;
  const pw2 = `${pw}2`;
  const fail = opts?.onFailure ?? 'exit 1';
  return [
    `if [ -n "\${${pw}:-}" ]; then`,
    '  export RCLONE_CONFIG_FLUI_CRYPT_TYPE=crypt',
    `  export RCLONE_CONFIG_FLUI_CRYPT_REMOTE=${PLAIN_REMOTE}:`,
    '  export RCLONE_CONFIG_FLUI_CRYPT_FILENAME_ENCRYPTION=off',
    '  export RCLONE_CONFIG_FLUI_CRYPT_DIRECTORY_NAME_ENCRYPTION=false',
    `  RCLONE_CONFIG_FLUI_CRYPT_PASSWORD="$(printf '%s' "\${${pw}}" | ${rclone} obscure -)" || ${fail}`,
    `  RCLONE_CONFIG_FLUI_CRYPT_PASSWORD2="$(printf '%s' "\${${pw2}:-}" | ${rclone} obscure -)" || ${fail}`,
    '  export RCLONE_CONFIG_FLUI_CRYPT_PASSWORD RCLONE_CONFIG_FLUI_CRYPT_PASSWORD2',
    'fi',
  ].join('\n');
}

/** A restore never mints a key: a destination without one cannot read ciphertext. */
export function restorePasswords(
  passphrase: string | undefined,
  destinationName: string,
): CryptPasswords {
  if (!passphrase) {
    throw new Error(
      `This backup is encrypted, but destination "${destinationName}" holds no passphrase to read it with`,
    );
  }
  return deriveCryptPasswords(passphrase);
}

export function remoteName(encrypted: boolean): string {
  return encrypted ? CRYPT_REMOTE : PLAIN_REMOTE;
}

/** What an artifact's `manifestSummary.repository.cipher` says, as a yes/no. */
export function isCryptSummary(
  summary: Record<string, unknown> | null | undefined,
): boolean {
  const repository = summary?.repository as { cipher?: unknown } | undefined;
  return repository?.cipher === RCLONE_CRYPT_CIPHER;
}

export function isEncryptedObjectKey(key: string): boolean {
  return key.endsWith(CRYPT_SUFFIX);
}
