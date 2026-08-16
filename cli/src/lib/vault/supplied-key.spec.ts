import { randomBytes } from 'node:crypto';
import { SUPPLIED_KEY_VAR, suppliedProfileKey } from './supplied-key';

const KEY = randomBytes(32);

function env(value?: string): NodeJS.ProcessEnv {
  return value === undefined ? {} : { [SUPPLIED_KEY_VAR]: value };
}

describe('a profile key supplied by the caller', () => {
  it('is absent when nothing was supplied', () => {
    expect(suppliedProfileKey(env())).toBeNull();
    expect(suppliedProfileKey(env(''))).toBeNull();
    expect(suppliedProfileKey(env('   '))).toBeNull();
  });

  it('round-trips the exact bytes', () => {
    expect(suppliedProfileKey(env(KEY.toString('base64')))).toEqual(KEY);
  });

  it('accepts the URL-safe encoding of the same key', () => {
    const urlSafe = KEY.toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(suppliedProfileKey(env(urlSafe))).toEqual(KEY);
  });

  it('refuses a key of the wrong length rather than padding it', () => {
    // Truncation here would seal the run under a key nobody can reproduce.
    expect(() =>
      suppliedProfileKey(env(randomBytes(16).toString('base64'))),
    ).toThrow(/32 bytes/);
    expect(() =>
      suppliedProfileKey(env(randomBytes(48).toString('base64'))),
    ).toThrow(/32 bytes/);
  });

  it('refuses something that is not base64 at all', () => {
    // `Buffer.from` silently drops what it cannot read, so a passphrase typed
    // into this variable would otherwise become a short key, or an empty one.
    expect(() =>
      suppliedProfileKey(env('correct horse battery staple')),
    ).toThrow(/openssl rand -base64 32/);
  });
});
