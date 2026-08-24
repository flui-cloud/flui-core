import { WsAuthService } from './ws-auth.service';
import { IdentityRole } from '../entities/user.entity';

/**
 * Decision 115, on the third door.
 *
 * `JwtStrategy` was repaired to read both shapes of the provider's project-role
 * claim; this service — which authenticates every WebSocket in the product,
 * the browser terminal included — still read only the human one. The failure is
 * silent by construction: nothing throws, `roles` simply comes back empty, and
 * an empty `roles` is not a narrow ceiling but the absence of one.
 */

const MACHINE_CLAIM = 'urn:zitadel:iam:org:project:386547186109775904:roles';
const HUMAN_CLAIM = 'urn:zitadel:iam:org:project:roles';

function serviceFor(payload: Record<string, unknown>, isAdmin = false) {
  const config = {
    get: (key: string) =>
      key === 'OIDC_ISSUER'
        ? 'https://idp.example'
        : key === 'OIDC_JWKS_URI'
          ? 'https://idp.example/keys'
          : undefined,
  };
  const jwt = {
    decode: () => ({ header: { kid: 'kid-1' } }),
    verifyAsync: async () => payload,
  };
  const users = {
    findOne: async () => ({
      id: 'user-1',
      email: 'someone@example.com',
      role: null,
      isAdmin,
    }),
  };
  const service = new WsAuthService(
    config as never,
    jwt as never,
    { validate: jest.fn() } as never,
    users as never,
  );
  service.onModuleInit();
  // Signing key resolution is the one thing that would reach the network.
  (service as unknown as { jwksClient: unknown }).jwksClient = {
    getSigningKey: async () => ({ getPublicKey: () => 'public-key' }),
  };
  return service;
}

const socket = () =>
  ({
    handshake: { auth: { token: 'header.body.sig' }, headers: {}, query: {} },
  }) as never;

describe('WsAuthService — the roles claim a machine identity actually sends', () => {
  it('reads the project-scoped claim, which is the only one a client_credentials token carries', async () => {
    const service = serviceFor({
      sub: 'sub-1',
      email: 'agent@example.com',
      [MACHINE_CLAIM]: { 'mcp:app:read': { org: 'example' } },
    });

    const user = await service.authenticate(socket());

    expect(Object.keys(user.roles ?? {})).toEqual(['mcp:app:read']);
  });

  it('still reads the human claim, and merges when both arrive', async () => {
    const service = serviceFor({
      sub: 'sub-1',
      email: 'someone@example.com',
      [HUMAN_CLAIM]: { admin: { org: 'example' } },
      [MACHINE_CLAIM]: { 'mcp:app:read': { org: 'example' } },
    });

    const user = await service.authenticate(socket());

    expect(Object.keys(user.roles ?? {}).sort()).toEqual([
      'admin',
      'mcp:app:read',
    ]);
    // The rung still decides the identity role when the row carries none.
    expect(user.role).toBe(IdentityRole.ADMIN);
  });

  it('leaves roles empty when the token carries neither claim', async () => {
    const service = serviceFor({ sub: 'sub-1', email: 'nobody@example.com' });

    const user = await service.authenticate(socket());

    expect(user.roles).toEqual({});
    expect(user.role).toBe(IdentityRole.USER);
  });
});
