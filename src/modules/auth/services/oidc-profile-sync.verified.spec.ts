import { OidcProfileSyncService } from './oidc-profile-sync.service';
import { UserEntity } from '../entities/user.entity';

describe('OidcProfileSyncService and unverified addresses', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.ZITADEL_SERVICE_ACCOUNT_PAT = 'pat';
    process.env.OIDC_ISSUER = 'https://auth.example.com';
    delete process.env.AUTH_MODE;
  });
  afterAll(() => {
    process.env = env;
  });

  const build = (profile: Record<string, unknown> | null, fails = false) => {
    const oidcAdmin = {
      getUser: jest.fn(async () => {
        if (fails) throw new Error('provider down');
        return profile;
      }),
    };
    const userRepo = { save: async (u: UserEntity) => u };
    return {
      service: new OidcProfileSyncService(
        oidcAdmin as never,
        userRepo as never,
      ),
      oidcAdmin,
    };
  };

  const user = (email: string) =>
    ({
      id: 'u1',
      oidcSub: 'sub-1',
      email,
      profileSyncedAt: null,
    }) as UserEntity;

  it('adopts a verified address', async () => {
    const { service } = build({
      email: 'mario@example.com',
      emailVerified: true,
    });

    const synced = await service.syncFromProvider(
      user('oidc-sub-1@flui.invalid'),
    );

    expect(synced.email).toBe('mario@example.com');
  });

  it('ignores an unverified one, so permissions granted to it do not move', async () => {
    const { service } = build({
      email: 'admin@example.com',
      emailVerified: false,
    });

    const synced = await service.syncFromProvider(
      user('oidc-sub-1@flui.invalid'),
    );

    expect(synced.email).toBe('oidc-sub-1@flui.invalid');
  });

  it('answers whether an address is verified from the provider, and no when it cannot ask', async () => {
    expect(
      await build({
        email: 'a@b.c',
        emailVerified: true,
      }).service.isEmailVerified('sub-1'),
    ).toBe(true);
    expect(
      await build({
        email: 'a@b.c',
        emailVerified: false,
      }).service.isEmailVerified('sub-1'),
    ).toBe(false);
    expect(await build(null, true).service.isEmailVerified('sub-1')).toBe(
      false,
    );
    delete process.env.ZITADEL_SERVICE_ACCOUNT_PAT;
    expect(
      await build({
        email: 'a@b.c',
        emailVerified: true,
      }).service.isEmailVerified('sub-1'),
    ).toBe(false);
  });
});
