jest.mock('jwks-rsa', () => ({ passportJwtSecret: jest.fn(() => jest.fn()) }));

import { JwtStrategy } from './jwt.strategy';
import { IdentityRole } from '../entities/user.entity';

type Row = {
  id: string;
  email: string;
  oidcSub: string | null;
  role?: string;
  isAdmin?: boolean;
};

const harness = (rows: Row[], providerSaysVerified: boolean) => {
  const saved: Row[] = [];
  const self = {
    userRepo: {
      findOne: async ({ where }: { where: Partial<Row> }) =>
        rows.find((r) =>
          Object.entries(where).every(
            ([k, v]) => (r as Record<string, unknown>)[k] === v,
          ),
        ) ?? null,
      create: (data: Partial<Row>) => ({ id: 'new', ...data }) as Row,
      save: async (row: Row) => {
        saved.push(row);
        return row;
      },
    },
    profileSync: { isEmailVerified: jest.fn(async () => providerSaysVerified) },
    guestEnrolment: { enrol: jest.fn(async () => true) },
  };
  const resolve = (email: string | undefined, claim?: boolean) =>
    (
      JwtStrategy.prototype as unknown as {
        resolveLocalUser: (
          sub: string,
          email: string | undefined,
          role: IdentityRole,
          claim?: boolean,
        ) => Promise<Row>;
      }
    ).resolveLocalUser.call(self, 'sub-new', email, IdentityRole.USER, claim);
  return { resolve, saved, self };
};

describe('a new login and an existing account with the same email', () => {
  const admin = (): Row => ({
    id: 'admin',
    email: 'admin@example.com',
    oidcSub: null,
  });

  it('takes the account over when the token says the address is verified', async () => {
    const { resolve } = harness([admin()], false);

    const user = await resolve('admin@example.com', true);

    expect(user.id).toBe('admin');
    expect(user.oidcSub).toBe('sub-new');
  });

  it('never takes it over when the address is not verified, whatever the token says', async () => {
    const { resolve } = harness([admin()], true);

    const user = await resolve('admin@example.com', false);

    expect(user.id).toBe('new');
    expect(user.email).toBe('oidc-sub-new@flui.invalid');
  });

  it('asks the provider when the token does not say, and refuses on its no', async () => {
    const { resolve, self } = harness([admin()], false);

    const user = await resolve('admin@example.com', undefined);

    expect(self.profileSync.isEmailVerified).toHaveBeenCalledWith('sub-new');
    expect(user.id).toBe('new');
  });

  it('links on the provider yes when the token is silent', async () => {
    const { resolve } = harness([admin()], true);

    const user = await resolve('admin@example.com', undefined);

    expect(user.id).toBe('admin');
  });
});

describe('a brand new person', () => {
  it('keeps a verified address', async () => {
    const { resolve } = harness([], true);

    expect((await resolve('new@example.com', true)).email).toBe(
      'new@example.com',
    );
  });

  it('does not carry an unverified address, so nothing granted to it reaches them', async () => {
    const { resolve } = harness([], false);

    expect((await resolve('someone@example.com', false)).email).toBe(
      'oidc-sub-new@flui.invalid',
    );
  });
});

describe('enrolling a demo guest on first sign-in', () => {
  it('offers a brand new person for enrolment, with their address only if verified', async () => {
    const verified = harness([], true);
    await verified.resolve('new@example.com', true);
    expect(verified.self.guestEnrolment.enrol).toHaveBeenCalledWith({
      userId: 'new',
      email: 'new@example.com',
      hasProviderRoles: false,
    });

    const unverified = harness([], false);
    await unverified.resolve('someone@example.com', false);
    expect(unverified.self.guestEnrolment.enrol).toHaveBeenCalledWith(
      expect.objectContaining({ email: null }),
    );
  });

  it('never offers someone whose account already existed', async () => {
    const { resolve, self } = harness(
      [{ id: 'admin', email: 'admin@example.com', oidcSub: null }],
      true,
    );

    await resolve('admin@example.com', true);

    expect(self.guestEnrolment.enrol).not.toHaveBeenCalled();
  });
});
