import { UnauthorizedException } from '@nestjs/common';
import { WsAuthService } from './ws-auth.service';

/** F-109: a person an administrator blocked opens no socket, whichever token they still hold. */
describe('a blocked account on a websocket', () => {
  const build = (blockedAt: Date | null) => {
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
      verifyAsync: async () => ({ sub: 'user-1', email: 'a@example.com' }),
    };
    const users = {
      findOne: async () => ({
        id: 'user-1',
        email: 'a@example.com',
        isAdmin: false,
        blockedAt,
      }),
    };
    const service = new WsAuthService(
      config as never,
      jwt as never,
      { validate: jest.fn() } as never,
      users as never,
    );
    service.onModuleInit();
    (service as unknown as { jwksClient: unknown }).jwksClient = {
      getSigningKey: async () => ({ getPublicKey: () => 'public-key' }),
    };
    return service;
  };
  const socket = {
    handshake: { auth: { token: 'h.b.s' }, headers: {}, query: {} },
  } as never;
  const mode = process.env.AUTH_MODE;
  afterEach(() => {
    process.env.AUTH_MODE = mode;
  });

  it.each(['oidc', 'local'])(
    'is refused with an %s token',
    async (authMode) => {
      process.env.AUTH_MODE = authMode;
      await expect(
        build(new Date()).authenticate(socket),
      ).rejects.toBeInstanceOf(UnauthorizedException);
      await expect(build(null).authenticate(socket)).resolves.toMatchObject({
        userId: 'user-1',
      });
    },
  );
});
