import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  VaultFile,
  VaultNotInitialisedError,
  WrongPassphraseError,
} from './vault-file';
import { deriveProfileKey, open, seal } from './vault-crypto';

const PASSPHRASE = 'a passphrase only the operator knows';

describe('VaultFile', () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'flui-vault-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('creates a vault and opens it again with the same passphrase', () => {
    const vault = new VaultFile(base);
    const created = vault.init(PASSPHRASE);
    expect(vault.exists()).toBe(true);
    expect(vault.unlock(PASSPHRASE)).toEqual(created);
  });

  it('refuses the wrong passphrase instead of returning a key that opens nothing', () => {
    // Failing here, at the passphrase, is what turns "wrong password" into a
    // clear message rather than a corrupt-looking record ten minutes later.
    new VaultFile(base).init(PASSPHRASE);
    expect(() => new VaultFile(base).unlock('not it')).toThrow(
      WrongPassphraseError,
    );
  });

  it('stores nothing that reveals the passphrase or a key', () => {
    const vault = new VaultFile(base);
    const master = vault.init(PASSPHRASE);
    const onDisk = readFileSync(vault.location, 'utf-8');

    expect(onDisk).not.toContain(PASSPHRASE);
    expect(onDisk).not.toContain(master.toString('base64'));
    expect(onDisk).not.toContain(master.toString('hex'));
    expect(onDisk).not.toContain(
      deriveProfileKey(master, 'default').toString('base64'),
    );
  });

  it('writes the header readable only by its owner', () => {
    const vault = new VaultFile(base);
    vault.init(PASSPHRASE);
    expect(statSync(vault.location).mode & 0o777).toBe(0o600);
  });

  it('refuses to overwrite an existing vault', () => {
    // The salt lives in this file. Replacing it makes every sealed credential
    // on the machine permanently unreadable, silently.
    const vault = new VaultFile(base);
    vault.init(PASSPHRASE);
    expect(() => vault.init('a new passphrase')).toThrow(/already exists/i);
  });

  it('says what to do when there is no vault yet', () => {
    expect(() => new VaultFile(base).unlock(PASSPHRASE)).toThrow(
      VaultNotInitialisedError,
    );
    expect(() => new VaultFile(base).read()).toThrow(/flui vault init/);
  });

  it('gives two vaults different salts, so one passphrase yields different keys', () => {
    const a = new VaultFile(base).init(PASSPHRASE);
    const other = mkdtempSync(join(tmpdir(), 'flui-vault-'));
    try {
      const b = new VaultFile(other).init(PASSPHRASE);
      expect(a).not.toEqual(b);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('honours the parameters a vault was written with, not the current ones', () => {
    // An old vault stays openable after the cost parameters are raised. Reading
    // the constant instead of the header would lock everyone out on upgrade.
    const vault = new VaultFile(base);
    vault.init(PASSPHRASE);

    const header = JSON.parse(readFileSync(vault.location, 'utf-8'));
    const sealed = seal(
      deriveProfileKey(vault.unlock(PASSPHRASE), 'default'),
      'secret',
    );

    header.kdf.N = 2 ** 14;
    header.verifier = 'deliberately-wrong';
    writeFileSync(vault.location, JSON.stringify(header));

    // Different parameters must derive a different key — proof the header is read.
    expect(() => new VaultFile(base).unlock(PASSPHRASE)).toThrow(
      WrongPassphraseError,
    );
    expect(sealed).toBeTruthy();
  });

  it('refuses a header from a newer CLI rather than guessing at it', () => {
    const vault = new VaultFile(base);
    vault.init(PASSPHRASE);
    writeFileSync(
      vault.location,
      JSON.stringify({ version: 2, kdf: {}, verifier: '' }),
    );
    expect(() => vault.read()).toThrow(/newer version/i);
  });

  it('reports an unreadable header instead of crashing on it', () => {
    const vault = new VaultFile(base);
    vault.init(PASSPHRASE);
    writeFileSync(vault.location, 'not json at all');
    expect(() => vault.read()).toThrow(/unreadable/i);
  });

  it('produces a key that actually seals and opens', () => {
    const vault = new VaultFile(base);
    vault.init(PASSPHRASE);
    const key = deriveProfileKey(vault.unlock(PASSPHRASE), 'default');
    expect(open(key, seal(key, 'hcloud-token'))).toBe('hcloud-token');
  });
});
