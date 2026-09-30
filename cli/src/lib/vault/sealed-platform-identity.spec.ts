import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PlatformIdentityMissingError,
  SealedPlatformIdentity,
} from './sealed-platform-identity';
import {
  VaultLockedError,
  forgetProfileKeys,
  setProfileKey,
} from './session-key';
import { deriveProfileKey } from './vault-crypto';
import {
  VaultFile,
  VaultNotInitialisedError,
  WrongPassphraseError,
} from './vault-file';

const PROFILE = 'a-profile';
const PASSPHRASE = randomBytes(12).toString('hex');
const IDENTITY = `AGE-SECRET-KEY-${randomBytes(24).toString('hex').toUpperCase()}`;
const RECIPIENT = `age1${randomBytes(24).toString('hex')}`;

describe('SealedPlatformIdentity', () => {
  let home: string;
  let profileDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'flui-pbid-'));
    profileDir = join(home, 'profiles', PROFILE);
    mkdirSync(profileDir, { recursive: true });
  });

  afterEach(() => {
    forgetProfileKeys();
    rmSync(home, { recursive: true, force: true });
  });

  const identity = () => new SealedPlatformIdentity(PROFILE, profileDir, home);
  const initVault = () => new VaultFile(home).init(PASSPHRASE);
  const unlock = (master = initVault()) =>
    setProfileKey(PROFILE, deriveProfileKey(master, PROFILE));

  it('refuses to store before a vault exists, and while it is locked', () => {
    expect(() => identity().store(IDENTITY, RECIPIENT)).toThrow(
      VaultNotInitialisedError,
    );
    initVault();
    expect(() => identity().store(IDENTITY, RECIPIENT)).toThrow(
      VaultLockedError,
    );
    expect(identity().exists()).toBe(false);
  });

  it('keeps the identity sealed and the recipient readable without the vault', () => {
    unlock();
    identity().store(IDENTITY, RECIPIENT);

    const dir = join(profileDir, 'platform-backup');
    expect(readFileSync(join(dir, 'identity.sealed'), 'utf-8')).not.toContain(
      IDENTITY,
    );
    expect(statSync(join(dir, 'identity.sealed')).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);

    forgetProfileKeys();
    expect(identity().exists()).toBe(true);
    expect(identity().recipient()).toBe(RECIPIENT);
    expect(() => identity().identity()).toThrow(VaultLockedError);
  });

  it('opens the identity again once the vault is unlocked', () => {
    const master = initVault();
    unlock(master);
    identity().store(IDENTITY, RECIPIENT);
    forgetProfileKeys();

    unlock(new VaultFile(home).unlock(PASSPHRASE));
    expect(identity().identity()).toBe(IDENTITY);
  });

  it('keeps a replaced identity so older backups still open', () => {
    unlock();
    identity().store(IDENTITY, RECIPIENT);
    const next = `AGE-SECRET-KEY-${randomBytes(24).toString('hex').toUpperCase()}`;
    const nextRecipient = `age1${randomBytes(24).toString('hex')}`;
    identity().store(next, nextRecipient);

    expect(identity().identity()).toBe(next);
    expect(identity().recipient()).toBe(nextRecipient);
    expect(identity().identities()).toEqual([next, IDENTITY]);
  });

  it('says how to create one when the profile has none', () => {
    unlock();
    expect(identity().exists()).toBe(false);
    expect(identity().recipient()).toBeNull();
    expect(() => identity().identity()).toThrow(PlatformIdentityMissingError);
  });

  it('cannot be opened with another profile key', () => {
    const master = initVault();
    unlock(master);
    identity().store(IDENTITY, RECIPIENT);
    setProfileKey(PROFILE, deriveProfileKey(master, 'another-profile'));
    expect(() => identity().identity()).toThrow();
  });

  it('accepts only the vault passphrase for the recovery file', () => {
    initVault();
    expect(() => identity().verifyVaultPassphrase(PASSPHRASE)).not.toThrow();
    expect(() => identity().verifyVaultPassphrase('something else')).toThrow(
      WrongPassphraseError,
    );
  });
});
