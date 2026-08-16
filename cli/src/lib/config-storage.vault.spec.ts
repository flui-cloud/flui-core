import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { ConfigStorage } from './config-storage';
import { deriveMasterKey, deriveProfileKey, seal } from './vault/vault-crypto';
import {
  VaultLockedError,
  forgetProfileKeys,
  setProfileKey,
} from './vault/session-key';
import { ProfileManager } from './profile-manager';

const PROFILE = 'a-profile';
const MASTER = deriveMasterKey('a passphrase', Buffer.alloc(16, 1));
const SCALEWAY = { accessKey: 'SCWACCESSKEY', secretKey: 'scw-secret-value' };

describe('ConfigStorage under the vault', () => {
  let home: string;
  let profileDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'flui-cs-'));
    profileDir = join(home, 'profiles', PROFILE);
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
    jest.spyOn(ProfileManager, 'getProfileDir').mockReturnValue(profileDir);
    jest.spyOn(ProfileManager, 'getActiveProfile').mockReturnValue(PROFILE);
  });

  afterEach(() => {
    forgetProfileKeys();
    jest.restoreAllMocks();
    rmSync(home, { recursive: true, force: true });
  });

  /** A profile exactly as releases before the vault wrote it. */
  function seedLegacyProfile(): Buffer {
    const legacyKey = randomBytes(32);
    writeFileSync(join(profileDir, '.key'), legacyKey, { mode: 0o600 });
    writeFileSync(
      join(profileDir, 'config.json'),
      JSON.stringify({
        tokens: {
          hetzner: {
            encrypted: seal(legacyKey as never, 'hcloud-real-token'),
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
        // Stored as JSON: a compound credential is an object, not a string.
        credentials: {
          scaleway: seal(legacyKey as never, JSON.stringify(SCALEWAY)),
        },
        apiKey: seal(legacyKey as never, 'flui-api-key'),
        preferences: { email: 'owner@example.com' },
        metadata: { version: '1.0.0', createdAt: '', updatedAt: '' },
      }),
      { mode: 0o600 },
    );
    return legacyKey;
  }

  it('still opens a profile that predates the vault, so an upgrade locks nobody out', () => {
    seedLegacyProfile();
    expect(new ConfigStorage(PROFILE).getToken('hetzner')).toBe(
      'hcloud-real-token',
    );
  });

  it('moves every secret onto the vault key and deletes the old key file', () => {
    seedLegacyProfile();
    const storage = new ConfigStorage(PROFILE);
    expect(storage.hasLegacyKeyFile()).toBe(true);

    const moved = storage.adoptVaultKey(deriveProfileKey(MASTER, PROFILE));

    expect(moved).toBe(3); // token, credential, api key
    expect(existsSync(join(profileDir, '.key'))).toBe(false);
    expect(storage.hasLegacyKeyFile()).toBe(false);
  });

  it('keeps every secret readable after the move', () => {
    seedLegacyProfile();
    new ConfigStorage(PROFILE).adoptVaultKey(deriveProfileKey(MASTER, PROFILE));

    setProfileKey(PROFILE, deriveProfileKey(MASTER, PROFILE));
    const storage = new ConfigStorage(PROFILE);
    expect(storage.getToken('hetzner')).toBe('hcloud-real-token');
    expect(storage.getCredentials('scaleway')).toEqual(SCALEWAY);
    expect(storage.getApiKey()).toBe('flui-api-key');
  });

  it('leaves the old key unable to open the moved records', () => {
    // The point of the exercise: that file sat next to the data it protected.
    const legacyKey = seedLegacyProfile();
    new ConfigStorage(PROFILE).adoptVaultKey(deriveProfileKey(MASTER, PROFILE));

    const moved = JSON.parse(
      readFileSync(join(profileDir, 'config.json'), 'utf-8'),
    );
    expect(() =>
      require('./vault/vault-crypto').open(
        legacyKey,
        moved.tokens.hetzner.encrypted,
      ),
    ).toThrow();
  });

  it('does nothing on a profile that has already moved', () => {
    seedLegacyProfile();
    const storage = new ConfigStorage(PROFILE);
    storage.adoptVaultKey(deriveProfileKey(MASTER, PROFILE));
    expect(storage.adoptVaultKey(deriveProfileKey(MASTER, PROFILE))).toBe(0);
  });

  it('preserves the metadata around a token, not just its value', () => {
    seedLegacyProfile();
    new ConfigStorage(PROFILE).adoptVaultKey(deriveProfileKey(MASTER, PROFILE));

    const moved = JSON.parse(
      readFileSync(join(profileDir, 'config.json'), 'utf-8'),
    );
    expect(moved.tokens.hetzner.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(moved.preferences.email).toBe('owner@example.com');
  });

  it('reads a plaintext preference with the vault locked', () => {
    // Most commands never touch a secret. Demanding a passphrase for a
    // preference teaches operators to type it without thinking.
    seedLegacyProfile();
    new ConfigStorage(PROFILE).adoptVaultKey(deriveProfileKey(MASTER, PROFILE));

    const storage = new ConfigStorage(PROFILE);
    expect(storage.getPreference('email')).toBe('owner@example.com');
  });

  it('says what to do when a secret is asked for and the vault is locked', () => {
    seedLegacyProfile();
    new ConfigStorage(PROFILE).adoptVaultKey(deriveProfileKey(MASTER, PROFILE));

    expect(() => new ConfigStorage(PROFILE).getToken('hetzner')).toThrow(
      VaultLockedError,
    );
    expect(() => new ConfigStorage(PROFILE).getToken('hetzner')).toThrow(
      /flui vault unlock/,
    );
  });

  it('seals a new secret under the vault key when one is available', () => {
    setProfileKey(PROFILE, deriveProfileKey(MASTER, PROFILE));
    const storage = new ConfigStorage(PROFILE);
    storage.saveToken('hetzner', 'a-fresh-token');

    expect(existsSync(join(profileDir, '.key'))).toBe(false);
    expect(
      readFileSync(join(profileDir, 'config.json'), 'utf-8'),
    ).not.toContain('a-fresh-token');
    expect(storage.getToken('hetzner')).toBe('a-fresh-token');
  });
});
