import {
  identitySignatureHeader,
  verifyIdentitySignature,
} from './identity-email-signature.util';

const KEY = 'test-key';
const BODY = '{"a":1}';
const T = 1_700_000_000;
const NOW = T * 1000;

describe('verifying the identity provider signature', () => {
  it('matches the identity provider format: HMAC-SHA256 over "<t>.<body>", hex', () => {
    expect(identitySignatureHeader(T, BODY, KEY)).toBe(
      't=1700000000,v1=fe8e300d70576272b1c2ee86ca552aefaeaae9321a576f1f3a21b6eef608177e',
    );
  });

  it('accepts a valid signature over the exact bytes', () => {
    const header = identitySignatureHeader(T, BODY, KEY);
    expect(verifyIdentitySignature(header, BODY, KEY, NOW)).toBe('valid');
    expect(verifyIdentitySignature(header, Buffer.from(BODY), KEY, NOW)).toBe(
      'valid',
    );
  });

  it('accepts any one of several v1 signatures', () => {
    const good = identitySignatureHeader(T, BODY, KEY).split(',')[1];
    const header = `t=${T},v1=${'00'.repeat(32)},${good}`;
    expect(verifyIdentitySignature(header, BODY, KEY, NOW)).toBe('valid');
  });

  it('refuses a signature made with another key', () => {
    const header = identitySignatureHeader(T, BODY, 'other-key');
    expect(verifyIdentitySignature(header, BODY, KEY, NOW)).toBe('mismatch');
  });

  it('refuses a body changed after signing', () => {
    const header = identitySignatureHeader(T, BODY, KEY);
    expect(verifyIdentitySignature(header, '{"a":2}', KEY, NOW)).toBe(
      'mismatch',
    );
  });

  it('refuses a missing header', () => {
    expect(verifyIdentitySignature(undefined, BODY, KEY, NOW)).toBe('missing');
    expect(verifyIdentitySignature('  ', BODY, KEY, NOW)).toBe('missing');
  });

  it('refuses a header it cannot read', () => {
    expect(verifyIdentitySignature('garbage', BODY, KEY, NOW)).toBe(
      'malformed',
    );
    expect(verifyIdentitySignature(`t=${T}`, BODY, KEY, NOW)).toBe('malformed');
    expect(verifyIdentitySignature('t=abc,v1=00', BODY, KEY, NOW)).toBe(
      'malformed',
    );
    expect(
      verifyIdentitySignature(`v1=${'00'.repeat(32)}`, BODY, KEY, NOW),
    ).toBe('malformed');
  });

  it('refuses a stale timestamp, and one from too far ahead', () => {
    const header = identitySignatureHeader(T, BODY, KEY);
    expect(verifyIdentitySignature(header, BODY, KEY, NOW + 301_000)).toBe(
      'stale',
    );
    expect(verifyIdentitySignature(header, BODY, KEY, NOW - 301_000)).toBe(
      'stale',
    );
    expect(verifyIdentitySignature(header, BODY, KEY, NOW + 299_000)).toBe(
      'valid',
    );
  });
});
