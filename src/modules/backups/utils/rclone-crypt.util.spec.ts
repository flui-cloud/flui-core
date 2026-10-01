import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RCLONE_CRYPT_CIPHER,
  cryptEnv,
  cryptSetupScript,
  deriveCryptPasswords,
  isCryptSummary,
  isEncryptedObjectKey,
  restorePasswords,
} from './rclone-crypt.util';

describe('rclone crypt keys', () => {
  it('derives the same two secrets from the same passphrase, every time', () => {
    const a = deriveCryptPasswords('destination-passphrase');
    const b = deriveCryptPasswords('destination-passphrase');
    expect(a).toEqual(b);
    expect(a.password).not.toBe(a.password2);
    expect(a.password).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(a)).not.toContain('destination-passphrase');
  });

  it('derives different secrets for a different passphrase', () => {
    expect(deriveCryptPasswords('one')).not.toEqual(
      deriveCryptPasswords('two'),
    );
  });

  it('refuses to derive from nothing', () => {
    expect(() => deriveCryptPasswords('')).toThrow();
    expect(() => restorePasswords(undefined, 'scaleway')).toThrow(
      /holds no passphrase/,
    );
  });

  it('names the environment the pod reads them from', () => {
    const p = deriveCryptPasswords('x');
    expect(Object.keys(cryptEnv(p))).toEqual([
      'FLUI_CRYPT_PASSWORD',
      'FLUI_CRYPT_PASSWORD2',
    ]);
    expect(Object.keys(cryptEnv(p, 'FLUI_MARIADB_CRYPT_'))).toEqual([
      'FLUI_MARIADB_CRYPT_PASSWORD',
      'FLUI_MARIADB_CRYPT_PASSWORD2',
    ]);
  });

  it('tells an encrypted artifact and object from a plaintext one', () => {
    expect(
      isCryptSummary({ repository: { cipher: RCLONE_CRYPT_CIPHER } }),
    ).toBe(true);
    expect(isCryptSummary({ repository: { cipher: 'none' } })).toBe(false);
    expect(isCryptSummary({})).toBe(false);
    expect(isCryptSummary(undefined)).toBe(false);
    expect(isEncryptedObjectKey('dumps/a/L/dump.pgdump.bin')).toBe(true);
    expect(isEncryptedObjectKey('dumps/a/L/dump.pgdump')).toBe(false);
  });
});

describe('the shell that configures flui_crypt', () => {
  const run = (env: Record<string, string>) => {
    const dir = mkdtempSync(join(tmpdir(), 'crypt-'));
    const rclone = join(dir, 'rclone');
    // Records how it was called: the secret must arrive on stdin, not argv.
    writeFileSync(
      rclone,
      '#!/bin/sh\necho "argv=$*" >> "$(dirname "$0")/calls"\nprintf "obscured(%s)" "$(cat)"\n',
    );
    chmodSync(rclone, 0o755);
    const out = execFileSync(
      'bash',
      [
        '-c',
        `set -euo pipefail\n${cryptSetupScript({ rclone })}\n` +
          'echo "TYPE=${RCLONE_CONFIG_FLUI_CRYPT_TYPE:-}"\n' +
          'echo "REMOTE=${RCLONE_CONFIG_FLUI_CRYPT_REMOTE:-}"\n' +
          'echo "NAMES=${RCLONE_CONFIG_FLUI_CRYPT_FILENAME_ENCRYPTION:-}"\n' +
          'echo "PW=${RCLONE_CONFIG_FLUI_CRYPT_PASSWORD:-}"\n' +
          'echo "PW2=${RCLONE_CONFIG_FLUI_CRYPT_PASSWORD2:-}"\n' +
          `cat "${dir}/calls" 2>/dev/null || true`,
      ],
      { env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf-8' },
    );
    return out;
  };

  it('configures the crypt remote from stdin-obscured secrets', () => {
    const out = run({ FLUI_CRYPT_PASSWORD: 'p1', FLUI_CRYPT_PASSWORD2: 'p2' });
    expect(out).toContain('TYPE=crypt');
    expect(out).toContain('REMOTE=flui:');
    expect(out).toContain('NAMES=off');
    expect(out).toContain('PW=obscured(p1)');
    expect(out).toContain('PW2=obscured(p2)');
    expect(out).toContain('argv=obscure -');
    expect(out).not.toMatch(/argv=.*p1/);
  });

  it('leaves rclone alone when no key was given', () => {
    const out = run({});
    expect(out).toContain('TYPE=\n');
    expect(out).not.toContain('argv=');
  });
});
