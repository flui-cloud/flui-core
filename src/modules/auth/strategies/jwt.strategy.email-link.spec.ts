jest.mock('jwks-rsa', () => ({ passportJwtSecret: jest.fn(() => jest.fn()) }));

import { JwtStrategy } from './jwt.strategy';
import { IdentityRole } from '../entities/user.entity';
import { SandboxGuestEnrolmentService } from '../../sandbox/gate/sandbox-guest-enrolment';
import { loadSandboxConfig } from '../../sandbox/sandbox.config';

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
    isTryToken: (JwtStrategy.prototype as unknown as { isTryToken: unknown })
      .isTryToken,
  };
  const resolve = (
    email: string | undefined,
    claim?: boolean,
    clientId: string | null = null,
    sub = 'sub-new',
  ) =>
    (
      JwtStrategy.prototype as unknown as {
        resolveLocalUser: (
          sub: string,
          email: string | undefined,
          role: IdentityRole,
          claim?: boolean,
          hasProviderRoles?: boolean,
          clientId?: string | null,
        ) => Promise<Row>;
      }
    ).resolveLocalUser.call(
      self,
      sub,
      email,
      IdentityRole.USER,
      claim,
      false,
      clientId,
    );
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

describe('a token of a visitor merged into another account', () => {
  it('is refused instead of making the visitor again as a new person', async () => {
    const { resolve, self, saved } = harness([], true);
    (self.guestEnrolment as Record<string, unknown>).isRetiredVisitor = jest.fn(
      async () => 'merged',
    );

    await expect(resolve('visitor-1@visitors.invalid', true)).rejects.toThrow(
      'This visit is now part of an account',
    );
    expect(saved).toHaveLength(0);
    expect(self.guestEnrolment.enrol).not.toHaveBeenCalled();
  });
});

describe('a token of a "try" application', () => {
  const env = process.env;
  beforeEach(() => {
    process.env = {
      ...env,
      OIDC_VISITOR_CLIENT_ID: 'try-web',
      OIDC_VISITOR_CLI_CLIENT_ID: 'try-cli',
    };
  });
  afterEach(() => {
    process.env = env;
  });

  it.each(['try-web', 'try-cli'])(
    'never makes a person when its visitor was swept (%s)',
    async (client) => {
      const { resolve, self, saved } = harness([], true);

      await expect(
        resolve('visitor-1@visitors.invalid', true, client),
      ).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'VISITOR_GONE' }),
      });
      expect(saved).toHaveLength(0);
      expect(self.guestEnrolment.enrol).not.toHaveBeenCalled();
    },
  );

  it('is refused when the visitor row says it was removed, whatever client', async () => {
    const { resolve, self, saved } = harness([], true);
    (self.guestEnrolment as Record<string, unknown>).isRetiredVisitor = jest.fn(
      async () => 'removed',
    );

    await expect(
      resolve('visitor-1@visitors.invalid', true, 'flui-web'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'VISITOR_GONE' }),
    });
    expect(saved).toHaveLength(0);
  });

  it('keeps working for a visitor that became an account on the same user', async () => {
    const { resolve, saved } = harness(
      [
        {
          id: 'u-1',
          email: 'me@example.com',
          oidcSub: 'idp-v1',
          role: 'user',
          isAdmin: false,
        },
      ],
      true,
    );

    const user = await resolve('me@example.com', true, 'try-web', 'idp-v1');

    expect(user.id).toBe('u-1');
    expect(saved).toHaveLength(0);
  });

  it('does not touch a token of the normal application', async () => {
    const { resolve } = harness([], true);
    expect((await resolve('new@example.com', true, 'flui-web')).id).toBe('new');
  });
});

describe('a token whose identity Flui made for a visitor', () => {
  const env = process.env;
  beforeEach(() => {
    process.env = { ...env };
    delete process.env.OIDC_VISITOR_CLIENT_ID;
    delete process.env.OIDC_VISITOR_CLI_CLIENT_ID;
  });
  afterEach(() => {
    process.env = env;
  });

  const useRealEnrolment = (
    target: object,
    visitorRow: Record<string, unknown> | null,
    loginClientRow: Record<string, unknown> | null = null,
  ) => {
    const real = new SandboxGuestEnrolmentService(
      {} as never,
      loadSandboxConfig({ SANDBOX_ENABLED: 'true' }),
      { findOne: jest.fn(async () => visitorRow) } as never,
      { findOne: jest.fn(async () => loginClientRow) } as never,
    );
    Object.assign(target, {
      isRetiredVisitor: real.isRetiredVisitor.bind(real),
      isTryClient: real.isTryClient.bind(real),
    });
  };

  it('is VISITOR_GONE when its row exists and its person is gone, even before the row was marked removed', async () => {
    const { resolve, self, saved } = harness([], true);
    useRealEnrolment(self.guestEnrolment, {
      idpUserId: 'idp-v9',
      linkedUserId: null,
      removedAt: null,
      upgradedAt: null,
    });

    await expect(
      resolve('visitor-9@visitors.invalid', true, 'flui-web', 'idp-v9'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'VISITOR_GONE' }),
    });
    expect(saved).toHaveLength(0);
    expect(self.guestEnrolment.enrol).not.toHaveBeenCalled();
  });

  it('is VISITOR_GONE for a try application known only from the stored row, after the entrance was shut', async () => {
    const { resolve, self, saved } = harness([], true);
    useRealEnrolment(self.guestEnrolment, null, {
      webClientId: 'try-web',
      cliClientId: 'try-cli',
    });

    await expect(
      resolve('visitor-9@visitors.invalid', true, 'try-cli'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'VISITOR_GONE' }),
    });
    expect(saved).toHaveLength(0);
  });
});
