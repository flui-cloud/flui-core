import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Cost of turning a passphrase into a key.
 *
 * Measured at ~160 ms on an M-series laptop and around half a second on a small
 * VPS. That is the whole point: it is paid once per unlock and then not again
 * for half an hour, while an attacker working through a wordlist pays it on
 * every single guess. The memory cost is what makes it expensive to parallelise
 * on a GPU, so `r` and `N` matter more here than raw iterations would.
 */
export const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1 } as const;

/** scrypt needs 128 · N · r bytes; Node refuses above `maxmem` rather than swapping. */
const SCRYPT_MAXMEM = 256 * 1024 * 1024;

const KEY_BYTES = 32;
const SALT_BYTES = 16;
const IV_BYTES = 16;
const TAG_BYTES = 16;

/**
 * A key that opens exactly one profile.
 *
 * Branded so a profile key cannot be passed where a master key is expected, or
 * the other way round. The two are not interchangeable and confusing them would
 * silently widen what a single key can open.
 */
export type MasterKey = Buffer & { readonly __brand: 'flui-vault-master' };
export type ProfileKey = Buffer & { readonly __brand: 'flui-vault-profile' };

export function newSalt(): Buffer {
  return randomBytes(SALT_BYTES);
}

/**
 * Turns what the operator knows into what the vault needs.
 *
 * The passphrase itself is never stored, never derived back from anything, and
 * never leaves the process that read it. Lose it and the sealed entries are
 * gone — which is the property being bought, not a shortcoming.
 */
export function deriveMasterKey(
  passphrase: string,
  salt: Buffer,
  // Taken from the vault header, not from the constant above. These values get
  // raised as machines get faster, and an existing vault has to keep opening
  // under the parameters it was written with.
  params: { N: number; r: number; p: number } = SCRYPT_PARAMS,
): MasterKey {
  if (!passphrase) {
    throw new Error('A vault passphrase cannot be empty.');
  }
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_BYTES, {
    ...params,
    maxmem: SCRYPT_MAXMEM,
  }) as MasterKey;
}

/**
 * Narrows the master key to a single profile.
 *
 * Profiles hold different providers' credentials — a test account and a
 * production one. Deriving per profile means a command working in one cannot
 * open the other's entries even though both are sealed under the same
 * passphrase, so a mistake stays inside the profile that made it.
 */
export function deriveProfileKey(
  master: MasterKey,
  profile: string,
): ProfileKey {
  return Buffer.from(
    hkdfSync(
      'sha256',
      master,
      Buffer.alloc(0),
      `flui-vault-profile-v1:${profile}`,
      KEY_BYTES,
    ),
  ) as ProfileKey;
}

/**
 * Proves a passphrase is right without storing anything that reveals it.
 *
 * Derived from the master key down a different HKDF label than any profile key,
 * so holding the verifier tells an attacker nothing about what the profile keys
 * are — it only lets the vault answer "wrong passphrase" instead of handing
 * back garbage that fails much later as a corrupt-looking record.
 */
export function deriveVerifier(master: MasterKey): string {
  return Buffer.from(
    hkdfSync(
      'sha256',
      master,
      Buffer.alloc(0),
      'flui-vault-verifier-v1',
      KEY_BYTES,
    ),
  ).toString('base64');
}

export function verifierMatches(master: MasterKey, expected: string): boolean {
  const actual = Buffer.from(deriveVerifier(master), 'base64');
  const stored = Buffer.from(expected, 'base64');
  return actual.length === stored.length && timingSafeEqual(actual, stored);
}

/**
 * Seals a secret. The wire format is `iv:authTag:ciphertext` in hex, which is
 * the format profiles already hold — an entry sealed under the vault is shaped
 * exactly like one sealed under the old key file, so nothing but the key
 * changes and existing readers keep working.
 */
export function seal(key: ProfileKey, plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  return [
    iv.toString('hex'),
    cipher.getAuthTag().toString('hex'),
    encrypted.toString('hex'),
  ].join(':');
}

export function open(key: ProfileKey, sealed: string): string {
  const parts = sealed.split(':');
  if (parts.length !== 3) {
    throw new Error('Not a sealed value.');
  }
  const [ivHex, tagHex, bodyHex] = parts;
  const tag = Buffer.from(tagHex, 'hex');
  if (tag.length !== TAG_BYTES) {
    throw new Error('Not a sealed value.');
  }

  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(ivHex, 'hex'),
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(Buffer.from(bodyHex, 'hex')),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Overwrites key material once it is no longer needed.
 *
 * Best-effort, and worth being honest about: this runtime copies buffers during
 * garbage collection and can page them to swap, so a key that has lived in
 * memory cannot be guaranteed gone. It shortens the window rather than closing
 * it. Closing it would mean not holding keys in this runtime at all.
 */
export function wipe(key: Buffer): void {
  key.fill(0);
}
