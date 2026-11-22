import { createHash } from 'node:crypto';
import { fromPublic } from 'nkeys.js';
import {
  accountJwt,
  base32,
  keyFromSeed,
  natsCreds,
  newAccountKey,
  newOperatorKey,
  newUserKey,
  operatorJwt,
  seedOf,
  userJwt,
} from './nats-jwt';

const parts = (jwt: string) => {
  const [head, body, sig] = jwt.split('.');
  return {
    head: JSON.parse(Buffer.from(head, 'base64url').toString()),
    claims: JSON.parse(Buffer.from(body, 'base64url').toString()),
    unsigned: `${head}.${body}`,
    sig: Buffer.from(sig, 'base64url'),
  };
};

describe('NATS JWTs Flui signs', () => {
  const operator = newOperatorKey();
  const account = newAccountKey();
  const user = newUserKey();

  it('encodes base32 without padding, as RFC 4648 does', () => {
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('names the operator and its system account, signed by the operator', () => {
    const jwt = parts(operatorJwt(operator, 'flui', account.getPublicKey()));
    expect(jwt.head).toEqual({ typ: 'JWT', alg: 'ed25519-nkey' });
    expect(jwt.claims).toMatchObject({
      iss: operator.getPublicKey(),
      sub: operator.getPublicKey(),
      nats: {
        type: 'operator',
        system_account: account.getPublicKey(),
        version: 2,
      },
    });
    expect(
      fromPublic(operator.getPublicKey()).verify(
        Buffer.from(jwt.unsigned),
        jwt.sig,
      ),
    ).toBe(true);
  });

  it('gives an id the server can recompute from the claims', () => {
    const { claims } = parts(
      accountJwt(operator, account.getPublicKey(), 'app'),
    );
    const id = claims.jti;
    const expected = base32(
      createHash('sha512-256')
        .update(JSON.stringify({ ...claims, jti: '' }))
        .digest(),
    );
    expect(id).toBe(expected);
  });

  it('turns JetStream on for an app account and off for the system account', () => {
    const app = parts(
      accountJwt(operator, account.getPublicKey(), 'app'),
    ).claims;
    const sys = parts(
      accountJwt(operator, account.getPublicKey(), 'SYS', false),
    ).claims;
    expect(app.nats.limits.disk_storage).toBe(-1);
    expect(sys.nats.limits.disk_storage).toBeUndefined();
  });

  it('signs a user with its account, and writes creds a client can read back', () => {
    const jwt = userJwt(account, user.getPublicKey(), 'app');
    expect(parts(jwt).claims.iss).toBe(account.getPublicKey());
    const creds = natsCreds(jwt, user);
    expect(creds).toContain(jwt);
    expect(keyFromSeed(seedOf(user)).getPublicKey()).toBe(user.getPublicKey());
    expect(creds).toContain(seedOf(user));
  });
});
