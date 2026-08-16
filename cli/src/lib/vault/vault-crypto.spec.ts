import {
  deriveMasterKey,
  deriveProfileKey,
  deriveVerifier,
  newSalt,
  open,
  seal,
  verifierMatches,
  wipe,
  SCRYPT_PARAMS,
} from './vault-crypto';

const SALT = Buffer.alloc(16, 7);
const PASSPHRASE = 'correct horse battery staple';

describe('deriveMasterKey', () => {
  it('is deterministic for the same passphrase and salt', () => {
    expect(deriveMasterKey(PASSPHRASE, SALT)).toEqual(
      deriveMasterKey(PASSPHRASE, SALT),
    );
  });

  it('gives a different key for a different passphrase', () => {
    expect(deriveMasterKey(PASSPHRASE, SALT)).not.toEqual(
      deriveMasterKey('a different passphrase', SALT),
    );
  });

  it('gives a different key for a different salt', () => {
    // Two machines with the same passphrase must not share key material, and a
    // precomputed table for one vault must not open another.
    expect(deriveMasterKey(PASSPHRASE, SALT)).not.toEqual(
      deriveMasterKey(PASSPHRASE, Buffer.alloc(16, 9)),
    );
  });

  it('normalises the passphrase, so an accented character typed two ways still opens it', () => {
    // "é" as one code point, and as "e" plus a combining accent. They look
    // identical, come from different keyboards, and without NFKC one of them
    // locks the operator out of their own vault.
    expect(deriveMasterKey('caffé', SALT)).toEqual(
      deriveMasterKey('caffé', SALT),
    );
  });

  it('refuses an empty passphrase', () => {
    expect(() => deriveMasterKey('', SALT)).toThrow(/cannot be empty/i);
  });

  it('is expensive on purpose', () => {
    expect(SCRYPT_PARAMS.N).toBeGreaterThanOrEqual(2 ** 17);
  });

  it('produces a 32-byte key', () => {
    expect(deriveMasterKey(PASSPHRASE, SALT)).toHaveLength(32);
  });
});

describe('deriveProfileKey', () => {
  const master = deriveMasterKey(PASSPHRASE, SALT);

  it('gives each profile a key that cannot open another', () => {
    const production = deriveProfileKey(master, 'production-hz');
    const test = deriveProfileKey(master, 'scalaway-test');
    expect(production).not.toEqual(test);

    const sealed = seal(production, 'a-production-token');
    expect(() => open(test, sealed)).toThrow();
  });

  it('is stable for the same profile', () => {
    expect(deriveProfileKey(master, 'default')).toEqual(
      deriveProfileKey(master, 'default'),
    );
  });

  it('is not the master key itself', () => {
    expect(deriveProfileKey(master, 'default')).not.toEqual(master);
  });
});

describe('deriveVerifier', () => {
  const master = deriveMasterKey(PASSPHRASE, SALT);

  it('accepts the right passphrase and rejects a wrong one', () => {
    const stored = deriveVerifier(master);
    expect(verifierMatches(master, stored)).toBe(true);
    expect(verifierMatches(deriveMasterKey('wrong', SALT), stored)).toBe(false);
  });

  it('reveals nothing about any profile key', () => {
    // Both come from the master key, down different labels. Holding the
    // verifier — which sits in a file on disk — must not shorten the path to
    // the key that actually opens anything.
    const verifier = Buffer.from(deriveVerifier(master), 'base64');
    for (const profile of ['default', 'production-hz']) {
      expect(deriveProfileKey(master, profile)).not.toEqual(verifier);
    }
  });

  it('does not reject a malformed stored verifier by throwing', () => {
    expect(verifierMatches(master, 'not-base64-at-all!!')).toBe(false);
    expect(verifierMatches(master, '')).toBe(false);
  });
});

describe('seal and open', () => {
  const key = deriveProfileKey(deriveMasterKey(PASSPHRASE, SALT), 'default');

  it('round-trips a secret', () => {
    const sealed = seal(key, 'hcloud-token-value');
    expect(sealed).not.toContain('hcloud-token-value');
    expect(open(key, sealed)).toBe('hcloud-token-value');
  });

  it('keeps the format profiles already hold, so only the key changes', () => {
    expect(seal(key, 'x')).toMatch(/^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]*$/);
  });

  it('produces a different ciphertext each time', () => {
    expect(seal(key, 'same')).not.toEqual(seal(key, 'same'));
  });

  it('refuses a tampered ciphertext rather than returning junk', () => {
    const sealed = seal(key, 'trusted');
    const [iv, tag, body] = sealed.split(':');
    const flipped = `${iv}:${tag}:${body.slice(0, -2)}${body.slice(-2) === 'ff' ? '00' : 'ff'}`;
    expect(() => open(key, flipped)).toThrow();
  });

  it('refuses a tampered authentication tag', () => {
    const [iv, , body] = seal(key, 'trusted').split(':');
    expect(() => open(key, `${iv}:${'0'.repeat(32)}:${body}`)).toThrow();
  });

  it('refuses anything that is not a sealed value', () => {
    for (const value of ['', 'plain-text', 'a:b', 'a:b:c:d']) {
      expect(() => open(key, value)).toThrow();
    }
  });

  it('handles a secret with colons, which the format uses as a separator', () => {
    const awkward = 'user:pass:with:colons';
    expect(open(key, seal(key, awkward))).toBe(awkward);
  });

  it('handles a long multi-line secret', () => {
    const privateKey = `-----BEGIN OPENSSH PRIVATE KEY-----\n${'x'.repeat(2000)}\n-----END-----`;
    expect(open(key, seal(key, privateKey))).toBe(privateKey);
  });
});

describe('wipe', () => {
  it('overwrites the buffer it is given', () => {
    const key = deriveProfileKey(deriveMasterKey(PASSPHRASE, SALT), 'default');
    wipe(key);
    expect(key.every((byte) => byte === 0)).toBe(true);
  });
});

describe('newSalt', () => {
  it('is 16 bytes and never repeats', () => {
    const salts = new Set(
      Array.from({ length: 50 }, () => newSalt().toString('hex')),
    );
    expect(salts.size).toBe(50);
    expect(newSalt()).toHaveLength(16);
  });
});
