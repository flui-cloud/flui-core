import { createPrivateKey, createSign } from 'node:crypto';

export const ZITADEL_SYSTEM_USER = 'flui';

const b64 = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * A short-lived token for the system API user an identity install trusts by
 * certificate. Zitadel reads it as it is: no exchange at a token endpoint.
 */
export function zitadelSystemToken(
  privateKeyPem: string,
  issuer: string,
  now: number = Date.now(),
  ttlSeconds = 300,
): string {
  const iat = Math.floor(now / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: ZITADEL_SYSTEM_USER,
    sub: ZITADEL_SYSTEM_USER,
    aud: issuer,
    iat,
    exp: iat + ttlSeconds,
  })}`;
  const signature = createSign('RSA-SHA256')
    .update(unsigned)
    .sign(createPrivateKey(privateKeyPem))
    .toString('base64url');
  return `${unsigned}.${signature}`;
}
