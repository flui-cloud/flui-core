import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENCRYPTION_KEY_UNAVAILABLE_VAR,
  sealWithPlatformKey,
} from 'src/modules/shared/encryption/platform-cipher';
import {
  resolveCliEncryptionKey,
  withCliEncryptionKey,
  type ResolveOptions,
} from './encryption-key-env';
import { SealedEncryptionKey } from './sealed-encryption-key';
import { deriveMasterKey, deriveProfileKey } from './vault-crypto';
import { requireOpenVault } from './require-vault';
import { forgetProfileKeys, setProfileKey } from './session-key';

const PROFILE = 'a-profile';
const KEY = deriveProfileKey(
  deriveMasterKey('a passphrase', Buffer.alloc(16, 3)),
  PROFILE,
);

describe('the encryption key the CLI hands its services', () => {
  let home: string;
  let cwd: string;
  let profileDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'flui-eke-'));
    cwd = mkdtempSync(join(tmpdir(), 'flui-eke-cwd-'));
    profileDir = join(home, 'profiles', PROFILE);
    mkdirSync(profileDir, { recursive: true });
  });

  afterEach(() => {
    forgetProfileKeys();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const resolve = (profileKey: typeof KEY | null, extra: ResolveOptions = {}) =>
    resolveCliEncryptionKey({
      profile: PROFILE,
      profileDir,
      baseDir: home,
      cwd,
      profileKey,
      ...extra,
    });

  const initVault = (): void => writeFileSync(join(home, 'vault.json'), '{}');

  const writeClusters = (key: Buffer): void =>
    writeFileSync(
      join(profileDir, 'clusters.json'),
      JSON.stringify([{ k3sTokenEncrypted: sealWithPlatformKey(key, 't') }]),
    );

  it('opens the key sealed in the profile when the vault is open', () => {
    const sealed = randomBytes(32);
    new SealedEncryptionKey(PROFILE, profileDir).store(KEY, sealed);
    writeFileSync(join(cwd, '.env'), `ENCRYPTION_KEY=${'a'.repeat(64)}\n`);

    expect(resolve(KEY)).toEqual({ key: sealed, source: 'vault' });
  });

  it('never falls back to a file while a sealed key waits behind a locked vault', () => {
    initVault();
    new SealedEncryptionKey(PROFILE, profileDir).store(KEY, randomBytes(32));
    writeFileSync(join(home, 'encryption.key'), 'b'.repeat(64));

    const result = resolve(null);

    expect(result).toEqual({
      unavailable: expect.stringMatching(/vault is locked.*flui vault unlock/s),
    });
  });

  it('uses the plaintext file of a profile not migrated yet', () => {
    const fileKey = randomBytes(32);
    writeFileSync(join(home, 'encryption.key'), fileKey.toString('hex'));
    writeClusters(fileKey);

    expect(resolve(null)).toMatchObject({ key: fileKey, source: 'legacy' });
  });

  it('keeps using the .env key an older CLI sealed the profile with, until it is migrated', () => {
    const fileKey = randomBytes(32);
    const dotenvKey = randomBytes(32);
    writeFileSync(join(home, 'encryption.key'), fileKey.toString('hex'));
    writeFileSync(
      join(cwd, '.env'),
      `ENCRYPTION_KEY=${dotenvKey.toString('hex')}\n`,
    );
    writeClusters(dotenvKey);

    expect(resolve(null)).toMatchObject({
      key: dotenvKey,
      label: join(cwd, '.env'),
    });
  });

  it('creates and seals a fresh key for a profile with nothing sealed, only with the vault open', () => {
    initVault();
    expect(resolve(null)).toEqual({
      unavailable: expect.stringMatching(/flui vault unlock/),
    });
    expect(existsSync(join(profileDir, 'encryption.key.sealed'))).toBe(false);

    const created = resolve(KEY);

    expect(created).toMatchObject({ source: 'new' });
    expect(new SealedEncryptionKey(PROFILE, profileDir).open(KEY)).toEqual(
      (created as { key: Buffer }).key,
    );
    expect(existsSync(join(home, 'encryption.key'))).toBe(false);
  });

  it('asks for a vault first when there is none', () => {
    expect(resolve(null)).toEqual({
      unavailable: expect.stringMatching(/flui vault init/),
    });
  });

  it('refuses rather than mint a key for data no known key opens', () => {
    writeClusters(randomBytes(32));

    expect(resolve(KEY)).toEqual({
      unavailable: expect.stringMatching(/no known key opens/),
    });
    expect(existsSync(join(profileDir, 'encryption.key.sealed'))).toBe(false);
  });

  describe('withCliEncryptionKey', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
    });

    it('overrides a key copied in from a .env file for the boot only', async () => {
      process.env.ENCRYPTION_KEY = 'c'.repeat(64);
      const key = randomBytes(32);
      let seen: string | undefined;

      await withCliEncryptionKey(
        async () => {
          seen = process.env.ENCRYPTION_KEY;
        },
        () => ({ key, source: 'vault' }),
      );

      expect(seen).toBe(key.toString('hex'));
      expect(process.env.ENCRYPTION_KEY).toBe('c'.repeat(64));
    });

    it('removes any key and passes the reason when there is none', async () => {
      process.env.ENCRYPTION_KEY = 'c'.repeat(64);
      let seen: Record<string, string | undefined> = {};

      await withCliEncryptionKey(
        async () => {
          seen = {
            key: process.env.ENCRYPTION_KEY,
            reason: process.env[ENCRYPTION_KEY_UNAVAILABLE_VAR],
          };
        },
        () => ({ unavailable: 'locked' }),
      );

      expect(seen).toEqual({ key: undefined, reason: 'locked' });
      expect(process.env[ENCRYPTION_KEY_UNAVAILABLE_VAR]).toBeUndefined();
    });
  });

  describe('requireOpenVault', () => {
    it('asks for a vault, then for the unlock, before anything creates secrets', () => {
      expect(() => requireOpenVault(PROFILE, home)).toThrow(/flui vault init/);
      initVault();
      expect(() => requireOpenVault(PROFILE, home)).toThrow(
        /flui vault unlock/,
      );
      setProfileKey(PROFILE, Buffer.from(KEY) as never);
      expect(() => requireOpenVault(PROFILE, home)).not.toThrow();
    });
  });
});
