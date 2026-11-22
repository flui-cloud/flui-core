import { createHash } from 'node:crypto';
import {
  KeyPair,
  createAccount,
  createOperator,
  createUser,
  fromSeed,
} from 'nkeys.js';

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding, the encoding NATS uses for a JWT id. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

const b64url = (value: object): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

export interface NatsLimits {
  subs: number;
  data: number;
  payload: number;
  imports: number;
  exports: number;
  wildcards: boolean;
  conn: number;
  leaf: number;
  mem_storage?: number;
  disk_storage?: number;
  streams?: number;
  consumer?: number;
}

export const UNLIMITED: NatsLimits = {
  subs: -1,
  data: -1,
  payload: -1,
  imports: -1,
  exports: -1,
  wildcards: true,
  conn: -1,
  leaf: -1,
};

/**
 * A NATS v2 JWT, signed by `issuer` with its nkey. The id is the base32 of
 * the SHA-512/256 of the claims written with an empty id, which is how the
 * server recomputes and checks it.
 */
export function natsJwt(
  issuer: KeyPair,
  subject: string,
  name: string,
  nats: Record<string, unknown>,
  now: number = Date.now(),
  ttlSeconds?: number,
): string {
  const iat = Math.floor(now / 1000);
  const claims = {
    jti: '',
    iat,
    ...(ttlSeconds ? { exp: iat + ttlSeconds } : {}),
    iss: issuer.getPublicKey(),
    name,
    sub: subject,
    nats: { ...nats, version: 2 },
  };
  claims.jti = base32(
    createHash('sha512-256').update(JSON.stringify(claims)).digest(),
  );
  const unsigned = `${b64url({ typ: 'JWT', alg: 'ed25519-nkey' })}.${b64url(claims)}`;
  const signature = Buffer.from(issuer.sign(Buffer.from(unsigned))).toString(
    'base64url',
  );
  return `${unsigned}.${signature}`;
}

export function operatorJwt(
  operator: KeyPair,
  name: string,
  systemAccount: string,
): string {
  return natsJwt(operator, operator.getPublicKey(), name, {
    type: 'operator',
    system_account: systemAccount,
  });
}

/** An account with JetStream on; `jetstream: false` for the system account. */
export function accountJwt(
  operator: KeyPair,
  account: string,
  name: string,
  jetstream = true,
): string {
  const limits: NatsLimits = jetstream
    ? {
        ...UNLIMITED,
        mem_storage: -1,
        disk_storage: -1,
        streams: -1,
        consumer: -1,
      }
    : UNLIMITED;
  return natsJwt(operator, account, name, { type: 'account', limits });
}

export function userJwt(
  account: KeyPair,
  user: string,
  name: string,
  ttlSeconds?: number,
): string {
  return natsJwt(
    account,
    user,
    name,
    {
      type: 'user',
      pub: {},
      sub: {},
      subs: -1,
      data: -1,
      payload: -1,
    },
    Date.now(),
    ttlSeconds,
  );
}

/** The `.creds` file a NATS client signs in with: the user JWT and the seed that proves it. */
export function natsCreds(jwt: string, user: KeyPair): string {
  const seed = new TextDecoder().decode(user.getSeed());
  return [
    '-----BEGIN NATS USER JWT-----',
    jwt,
    '------END NATS USER JWT------',
    '',
    '-----BEGIN USER NKEY SEED-----',
    seed,
    '------END USER NKEY SEED------',
    '',
  ].join('\n');
}

export const newOperatorKey = (): KeyPair => createOperator();
export const newAccountKey = (): KeyPair => createAccount();
export const newUserKey = (): KeyPair => createUser();
export const keyFromSeed = (seed: string): KeyPair =>
  fromSeed(new TextEncoder().encode(seed));
export const seedOf = (kp: KeyPair): string =>
  new TextDecoder().decode(kp.getSeed());
