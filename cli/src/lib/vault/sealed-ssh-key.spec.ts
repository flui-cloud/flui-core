import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SealedSshKey } from './sealed-ssh-key';
import { deriveMasterKey, deriveProfileKey } from './vault-crypto';
import { forgetProfileKeys, setProfileKey } from './session-key';

const PROFILE = 'a-profile';
const KEY = deriveProfileKey(
  deriveMasterKey('a passphrase', Buffer.alloc(16, 5)),
  PROFILE,
);

describe('SealedSshKey', () => {
  let home: string;
  let profileDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'flui-sshk-'));
    profileDir = join(home, 'profiles', PROFILE);
    mkdirSync(profileDir, { recursive: true });
  });

  afterEach(() => {
    forgetProfileKeys();
    rmSync(home, { recursive: true, force: true });
  });

  const sshKey = () => new SealedSshKey(PROFILE, profileDir, home);
  const unlock = () => setProfileKey(PROFILE, Buffer.from(KEY) as never);

  const writeLegacyKey = (): void => {
    mkdirSync(join(home, 'ssh'), { recursive: true });
    execFileSync(
      'ssh-keygen',
      ['-t', 'ed25519', '-f', join(home, 'ssh', 'id_rsa'), '-N', '', '-q'],
      { stdio: 'pipe' },
    );
  };

  it('refuses to create a key before a vault exists, and while it is locked', () => {
    expect(() => sshKey().create()).toThrow(/flui vault init/);
    writeFileSync(join(home, 'vault.json'), '{}');
    expect(() => sshKey().create()).toThrow(/flui vault unlock/);
    expect(existsSync(join(profileDir, 'ssh', 'id_rsa.sealed'))).toBe(false);
  });

  it('creates the key sealed, with only the public half in plaintext', () => {
    unlock();
    const publicKey = sshKey().create();

    expect(publicKey).toMatch(/^ssh-rsa /);
    const sealed = readFileSync(
      join(profileDir, 'ssh', 'id_rsa.sealed'),
      'utf-8',
    );
    expect(sealed).not.toMatch(/PRIVATE KEY/);
    expect(
      statSync(join(profileDir, 'ssh', 'id_rsa.sealed')).mode & 0o777,
    ).toBe(0o600);
    expect(existsSync(join(home, 'ssh', 'id_rsa'))).toBe(false);
  });

  it('hands out a private copy that is gone afterwards', async () => {
    unlock();
    sshKey().create();
    let copy = '';

    const content = await sshKey().withPrivateKeyFile(async (path) => {
      copy = path;
      expect(statSync(path).mode & 0o777).toBe(0o600);
      return readFileSync(path, 'utf-8');
    });

    expect(content).toMatch(/PRIVATE KEY/);
    expect(existsSync(copy)).toBe(false);
  });

  it('knows the path older records name it by', () => {
    expect(sshKey().isManaged(join(home, 'ssh', 'id_rsa'))).toBe(true);
    expect(sshKey().isManaged(join(home, 'elsewhere'))).toBe(false);
  });

  it('seals the plaintext key of an older CLI and leaves removing it to the caller', () => {
    writeLegacyKey();
    const plaintext = readFileSync(join(home, 'ssh', 'id_rsa'), 'utf-8');

    expect(sshKey().sealLegacy(KEY)).toBe(true);
    expect(sshKey().sealLegacy(KEY)).toBe(false);
    expect(existsSync(join(home, 'ssh', 'id_rsa'))).toBe(true);

    sshKey().removeLegacy();
    unlock();
    return sshKey()
      .withPrivateKeyFile((path) => readFileSync(path, 'utf-8'))
      .then((opened) => {
        expect(opened).toBe(plaintext);
        expect(sshKey().publicKey()).toMatch(/^ssh-ed25519 /);
      });
  });

  it('never seals a different plaintext key over the sealed one', () => {
    unlock();
    sshKey().create();
    writeLegacyKey();

    expect(() => sshKey().sealLegacy(KEY)).toThrow(/different Flui SSH key/);
    expect(existsSync(join(home, 'ssh', 'id_rsa'))).toBe(true);
  });
});
