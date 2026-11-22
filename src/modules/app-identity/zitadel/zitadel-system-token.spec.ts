import {
  createPublicKey,
  createVerify,
  generateKeyPairSync,
} from 'node:crypto';
import { zitadelSystemToken } from './zitadel-system-token';

describe('the token Flui manages an identity install with', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const token = zitadelSystemToken(
    pem,
    'https://id.example.com',
    Date.UTC(2026, 10, 21, 12),
  );
  const [head, body, sig] = token.split('.');
  const claims = JSON.parse(Buffer.from(body, 'base64url').toString());

  it('names the system user and the instance, and lasts five minutes', () => {
    expect(claims).toMatchObject({
      iss: 'flui',
      sub: 'flui',
      aud: 'https://id.example.com',
    });
    expect(claims.exp - claims.iat).toBe(300);
  });

  it('is signed with the install’s key', () => {
    const ok = createVerify('RSA-SHA256')
      .update(`${head}.${body}`)
      .verify(publicKey, Buffer.from(sig, 'base64url'));
    expect(ok).toBe(true);
  });
});
