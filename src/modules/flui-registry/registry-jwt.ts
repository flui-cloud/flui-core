import { KeyObject, sign } from 'node:crypto';

const encode = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** A compact ES256 JWS: the signature in the raw r||s form JOSE requires. */
export function signEs256Jwt(
  kid: string,
  claims: Record<string, unknown>,
  privateKey: KeyObject,
): string {
  const input = `${encode({ alg: 'ES256', typ: 'JWT', kid })}.${encode(claims)}`;
  const signature = sign('sha256', Buffer.from(input), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${input}.${signature.toString('base64url')}`;
}
