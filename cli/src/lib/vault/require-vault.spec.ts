import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireOpenVault } from './require-vault';
import { forgetProfileKeys, setProfileKey } from './session-key';
import type { ProfileKey } from './vault-crypto';

const KEY = Buffer.alloc(32, 9) as ProfileKey;

describe('refusing to create secrets nothing can seal', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'flui-require-vault-'));
  });

  afterEach(() => {
    forgetProfileKeys();
    rmSync(baseDir, { recursive: true, force: true });
  });

  /**
   * A caller that supplies the key has no vault and never will: the run's HOME
   * is thrown away with it. Asking for one stops every managed run before it
   * reaches the provider.
   */
  it('lets a profile through on its key alone, with no vault on the machine', () => {
    setProfileKey('managed', KEY);

    expect(() => requireOpenVault('managed', baseDir)).not.toThrow();
  });

  it('asks for a vault when there is neither a vault nor a key', () => {
    expect(() => requireOpenVault('default', baseDir)).toThrow(
      /flui vault init/,
    );
  });

  it('asks for an unlock when the vault exists but this profile has no key', () => {
    writeFileSync(join(baseDir, 'vault.json'), '{}');

    expect(() => requireOpenVault('default', baseDir)).toThrow(
      /flui vault unlock/,
    );
  });
});
