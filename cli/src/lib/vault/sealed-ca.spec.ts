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
import { SealedCa } from './sealed-ca';
import { deriveMasterKey, deriveProfileKey } from './vault-crypto';
import { forgetProfileKeys, setProfileKey } from './session-key';

const PROFILE = 'a-profile';
const KEY = deriveProfileKey(
  deriveMasterKey('a passphrase', Buffer.alloc(16, 1)),
  PROFILE,
);

describe('SealedCa', () => {
  let home: string;
  let profileDir: string;
  let caDir: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'flui-ca-spec-'));
    profileDir = join(home, 'profiles', PROFILE);
    caDir = join(profileDir, 'ca');
    mkdirSync(profileDir, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    forgetProfileKeys();
    rmSync(home, { recursive: true, force: true });
  });

  const ca = () => new SealedCa(PROFILE, profileDir);

  it('refuses to create a CA while the vault is locked', () => {
    expect(() => ca().create()).toThrow(/vault/i);
    expect(existsSync(join(caDir, 'ca_key'))).toBe(false);
  });

  it('creates the CA sealed, with no plaintext private key on disk', () => {
    setProfileKey(PROFILE, Buffer.from(KEY) as never);
    const publicKey = ca().create();

    expect(publicKey).toMatch(/^ssh-ed25519 /);
    expect(existsSync(join(caDir, 'ca_key'))).toBe(false);
    expect(readFileSync(join(caDir, 'ca_key.sealed'), 'utf-8')).not.toMatch(
      /PRIVATE KEY/,
    );
    expect(statSync(join(caDir, 'ca_key.sealed')).mode & 0o777).toBe(0o600);
    expect(ca().privateKey()).toMatch(/BEGIN OPENSSH PRIVATE KEY/);
    expect(ca().isSealed()).toBe(true);
  });

  it('cannot open the sealed CA once the vault is locked again', () => {
    setProfileKey(PROFILE, Buffer.from(KEY) as never);
    ca().create();
    forgetProfileKeys();

    expect(() => ca().privateKey()).toThrow(/vault/i);
    expect(ca().publicKey()).toMatch(/^ssh-ed25519 /);
  });

  it('seals a plaintext CA left by an older CLI and removes the plaintext', () => {
    mkdirSync(caDir, { recursive: true, mode: 0o700 });
    const keyPath = join(caDir, 'ca_key');
    execFileSync('ssh-keygen', [
      '-t',
      'ed25519',
      '-f',
      keyPath,
      '-N',
      '',
      '-q',
    ]);
    const original = readFileSync(keyPath, 'utf-8');

    expect(ca().sealExisting(Buffer.from(KEY) as never)).toBe(true);
    expect(existsSync(keyPath)).toBe(false);

    setProfileKey(PROFILE, Buffer.from(KEY) as never);
    expect(ca().privateKey()).toBe(original);
  });

  it('seals a plaintext CA on first use when the vault is open', () => {
    mkdirSync(caDir, { recursive: true, mode: 0o700 });
    const keyPath = join(caDir, 'ca_key');
    execFileSync('ssh-keygen', [
      '-t',
      'ed25519',
      '-f',
      keyPath,
      '-N',
      '',
      '-q',
    ]);
    setProfileKey(PROFILE, Buffer.from(KEY) as never);

    ca().privateKey();

    expect(existsSync(keyPath)).toBe(false);
    expect(ca().isSealed()).toBe(true);
  });

  it('signs with a temporary copy that is gone afterwards', () => {
    setProfileKey(PROFILE, Buffer.from(KEY) as never);
    ca().create();
    const userKey = join(home, 'user');
    execFileSync('ssh-keygen', [
      '-t',
      'ed25519',
      '-f',
      userKey,
      '-N',
      '',
      '-q',
    ]);

    let copy = '';
    ca().withPrivateKeyFile((caKeyPath) => {
      copy = caKeyPath;
      expect(statSync(caKeyPath).mode & 0o777).toBe(0o600);
      execFileSync(
        'ssh-keygen',
        [
          '-s',
          caKeyPath,
          '-I',
          'test',
          '-n',
          'root',
          '-V',
          '+60s',
          `${userKey}.pub`,
        ],
        { stdio: 'pipe' },
      );
    });

    expect(existsSync(copy)).toBe(false);
    expect(existsSync(`${userKey}-cert.pub`)).toBe(true);
  });

  it('never seals a different plaintext CA over the sealed one', () => {
    setProfileKey(PROFILE, Buffer.from(KEY) as never);
    ca().create();
    const sealedBefore = readFileSync(join(caDir, 'ca_key.sealed'), 'utf-8');
    const original = ca().privateKey();

    const keyPath = join(caDir, 'ca_key');
    rmSync(join(caDir, 'ca_key.pub'));
    execFileSync('ssh-keygen', [
      '-t',
      'ed25519',
      '-f',
      keyPath,
      '-N',
      '',
      '-q',
    ]);

    expect(() => ca().privateKey()).toThrow(/two different SSH CAs/);
    expect(existsSync(keyPath)).toBe(true);
    expect(readFileSync(join(caDir, 'ca_key.sealed'), 'utf-8')).toBe(
      sealedBefore,
    );
    rmSync(keyPath);
    expect(ca().privateKey()).toBe(original);
  });

  it('drops a plaintext copy that matches the sealed CA', () => {
    setProfileKey(PROFILE, Buffer.from(KEY) as never);
    ca().create();
    writeFileSync(join(caDir, 'ca_key'), ca().privateKey(), { mode: 0o600 });

    ca().privateKey();

    expect(existsSync(join(caDir, 'ca_key'))).toBe(false);
  });

  it('writes nothing new when there is no plaintext CA to seal', () => {
    writeFileSync(join(profileDir, 'placeholder'), '');
    expect(ca().sealExisting(Buffer.from(KEY) as never)).toBe(false);
  });
});
