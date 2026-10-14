import { HttpException } from '@nestjs/common';
import { USER_KIND } from '../auth/entities/user.entity';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { ACCOUNT_CODES, AccountService } from './account.service';

const SUB = 'zitadel-own';
const POLICY = {
  minLength: 8,
  requiresUppercase: true,
  requiresLowercase: true,
  requiresNumber: true,
  requiresSymbol: false,
};

const providerError = (status: number, message = 'refused') =>
  Object.assign(new Error(message), {
    response: { status, data: { message } },
  });

const caller = (over: Partial<AuthenticatedUser> = {}): AuthenticatedUser => ({
  userId: 'local-1',
  email: 'ada@example.com',
  roles: {},
  role: 'user' as never,
  ...over,
});

function build(
  opts: {
    row?: Record<string, unknown> | null;
    access?: { isSandbox?: boolean; isVisitor?: boolean };
    methods?: string[];
  } = {},
) {
  const client = {
    getUser: jest.fn().mockResolvedValue({
      userId: SUB,
      orgId: 'org-1',
      userName: 'ada',
      email: 'ada@example.com',
      emailVerified: true,
      givenName: 'Ada',
      familyName: 'Lovelace',
      displayName: 'Ada L',
    }),
    updateProfile: jest.fn().mockResolvedValue(undefined),
    authMethods: jest.fn().mockResolvedValue(opts.methods ?? ['PASSWORD']),
    passwordComplexity: jest.fn().mockResolvedValue(POLICY),
    checkPassword: jest.fn().mockResolvedValue('valid'),
    setPassword: jest.fn().mockResolvedValue(undefined),
    registerTotp: jest
      .fn()
      .mockResolvedValue({ uri: 'otpauth://x', secret: 'S' }),
    verifyTotp: jest.fn().mockResolvedValue(undefined),
    removeTotp: jest.fn().mockResolvedValue(undefined),
    listPasskeys: jest
      .fn()
      .mockResolvedValue([{ id: 'pk-1', name: 'Laptop', ready: true }]),
    removePasskey: jest.fn().mockResolvedValue(undefined),
    secondFactors: jest.fn().mockResolvedValue({
      totp: false,
      otpSms: false,
      otpEmail: false,
      securityKeys: [{ id: 'u2f-1', name: 'Key', ready: true }],
    }),
    removeSecurityKey: jest.fn().mockResolvedValue(undefined),
    listIdpLinks: jest
      .fn()
      .mockResolvedValue([
        { idpId: 'idp-gh', externalUserId: 'gh-1', externalUserName: 'ada' },
      ]),
    idpName: jest.fn().mockResolvedValue('GitHub'),
    removeIdpLink: jest.fn().mockResolvedValue(undefined),
  };
  const users = {
    findOne: jest
      .fn()
      .mockResolvedValue(
        opts.row === undefined
          ? { id: 'local-1', oidcSub: SUB, kind: USER_KIND.PERSON }
          : opts.row,
      ),
    update: jest.fn().mockResolvedValue(undefined),
  };
  const policy = {
    resolveAccess: jest.fn().mockResolvedValue({
      isSandbox: false,
      isVisitor: false,
      ...opts.access,
    }),
  };
  const service = new AccountService(
    client as never,
    users as never,
    policy as never,
  );
  return { service, client, users, policy };
}

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    const body = (error as HttpException).getResponse?.() as
      | { code?: string }
      | string;
    return typeof body === 'object'
      ? (body.code ?? (error as HttpException).getStatus())
      : (error as HttpException).getStatus();
  }
  return 'resolved';
}

describe('AccountService', () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.ZITADEL_SERVICE_ACCOUNT_PAT = 'pat';
    process.env.OIDC_ISSUER = 'https://auth.example.com';
    process.env.AUTH_MODE = 'oidc';
  });
  afterAll(() => {
    process.env = env;
  });

  describe('whose account', () => {
    it('acts on the provider id stored for the caller, never on anything else', async () => {
      const { service, client, users } = build();
      await service.overview(caller());
      expect(users.findOne).toHaveBeenCalledWith({ where: { id: 'local-1' } });
      expect(client.getUser).toHaveBeenCalledWith(
        'pat',
        'auth.example.com',
        SUB,
      );
      for (const call of client.authMethods.mock.calls) {
        expect(call[2]).toBe(SUB);
      }
    });

    it('refuses a visitor by its row and by its access, on reads as well', async () => {
      const byRow = build({
        row: { id: 'local-1', oidcSub: SUB, kind: USER_KIND.VISITOR },
      });
      expect(await codeOf(byRow.service.overview(caller()))).toBe(
        ACCOUNT_CODES.VISITOR,
      );
      const byAccess = build({ access: { isSandbox: true, isVisitor: true } });
      expect(await codeOf(byAccess.service.overview(caller()))).toBe(
        ACCOUNT_CODES.VISITOR,
      );
      expect(byAccess.client.getUser).not.toHaveBeenCalled();
    });

    it('answers a caller with no provider account, and local mode, without calling the provider', async () => {
      const unlinked = build({ row: { id: 'local-1', oidcSub: null } });
      expect(await codeOf(unlinked.service.overview(caller()))).toBe(
        ACCOUNT_CODES.NOT_LINKED,
      );
      process.env.AUTH_MODE = 'local';
      const local = build();
      expect(await codeOf(local.service.overview(caller()))).toBe(
        ACCOUNT_CODES.LOCAL_MODE,
      );
      expect(local.client.getUser).not.toHaveBeenCalled();
    });
  });

  it('puts profile, methods and named links together', async () => {
    const { service } = build({ methods: ['PASSWORD', 'IDP', 'PASSKEY'] });
    const view = await service.overview(caller());
    expect(view.profile).toEqual({
      userName: 'ada',
      email: 'ada@example.com',
      emailVerified: true,
      firstName: 'Ada',
      lastName: 'Lovelace',
      displayName: 'Ada L',
    });
    expect(view.security.password).toBe(true);
    expect(view.security.links).toEqual([
      {
        idpId: 'idp-gh',
        provider: 'GitHub',
        externalUserId: 'gh-1',
        externalUserName: 'ada',
      },
    ]);
    expect(view.limits).toEqual({ guest: false, canUnlink: true });
  });

  it('changes the name at the provider and in the local row', async () => {
    const { service, client, users } = build();
    await service.updateProfile(caller(), {
      firstName: ' Ada ',
      lastName: 'Lovelace',
    });
    expect(client.updateProfile).toHaveBeenCalledWith(
      'pat',
      'auth.example.com',
      SUB,
      {
        givenName: 'Ada',
        familyName: 'Lovelace',
        displayName: 'Ada Lovelace',
      },
    );
    expect(users.update).toHaveBeenCalledWith(
      { id: 'local-1' },
      expect.objectContaining({ firstName: 'Ada', name: 'Ada L' }),
    );
  });

  describe('password', () => {
    it('lists what the policy asks for', async () => {
      const { service, client } = build();
      const policy = await service.passwordPolicy(caller());
      expect(client.passwordComplexity).toHaveBeenCalledWith(
        'pat',
        'auth.example.com',
        'org-1',
      );
      expect(policy.requirements.map((r) => r.rule)).toEqual([
        'min-length',
        'uppercase',
        'lowercase',
        'number',
      ]);
    });

    it('refuses a new password the policy does not accept, before checking anything', async () => {
      const { service, client } = build();
      expect(
        await codeOf(service.changePassword(caller(), 'Old-pass1', 'short')),
      ).toBe(ACCOUNT_CODES.PASSWORD_POLICY);
      expect(client.checkPassword).not.toHaveBeenCalled();
      expect(client.setPassword).not.toHaveBeenCalled();
    });

    it('refuses a wrong current password', async () => {
      const { service, client } = build();
      client.checkPassword.mockResolvedValue('invalid');
      expect(
        await codeOf(service.changePassword(caller(), 'nope', 'NewPass123')),
      ).toBe(ACCOUNT_CODES.CURRENT_PASSWORD_INVALID);
      expect(client.setPassword).not.toHaveBeenCalled();
    });

    it('maps the provider refusing the new password to the policy error, in its own words', async () => {
      const { service, client } = build();
      client.setPassword.mockRejectedValue(
        providerError(400, 'Errors.Internal <raw provider text>'),
      );
      const attempt = service.changePassword(
        caller(),
        'Old-pass1',
        'NewPass123',
      );
      await expect(attempt).rejects.toMatchObject({
        response: {
          code: ACCOUNT_CODES.PASSWORD_POLICY,
          message: expect.stringContaining('at least 8 characters'),
        },
      });
      await expect(attempt).rejects.not.toMatchObject({
        response: { message: expect.stringContaining('raw provider text') },
      });
    });

    it('tells a locked or deactivated account from a wrong password', async () => {
      const { service, client } = build();
      client.checkPassword.mockResolvedValue('locked');
      expect(
        await codeOf(
          service.changePassword(caller(), 'Old-pass1', 'NewPass123'),
        ),
      ).toBe(ACCOUNT_CODES.ACCOUNT_LOCKED);
      expect(client.setPassword).not.toHaveBeenCalled();
    });

    it('sends the current password along with the new one', async () => {
      const { service, client } = build();
      await service.changePassword(caller(), 'Old-pass1', 'NewPass123');
      expect(client.checkPassword).toHaveBeenCalledWith(
        'pat',
        'auth.example.com',
        SUB,
        'Old-pass1',
      );
      expect(client.setPassword).toHaveBeenCalledWith(
        'pat',
        'auth.example.com',
        SUB,
        'Old-pass1',
        'NewPass123',
      );
    });
  });

  describe('second factors', () => {
    it('maps a rejected code and an existing app', async () => {
      const { service, client } = build();
      client.verifyTotp.mockRejectedValue(providerError(400));
      expect(await codeOf(service.verifyTotp(caller(), '123456'))).toBe(
        ACCOUNT_CODES.TOTP_CODE_INVALID,
      );
      client.registerTotp.mockRejectedValue(providerError(409));
      expect(await codeOf(service.startTotp(caller(), 'pw'))).toBe(
        ACCOUNT_CODES.TOTP_ALREADY_SET,
      );
    });

    it('sets up an app only after the current password, when the account has one', async () => {
      const { service, client } = build();
      expect(await codeOf(service.startTotp(caller()))).toBe(
        ACCOUNT_CODES.CURRENT_PASSWORD_INVALID,
      );
      client.checkPassword.mockResolvedValue('invalid');
      expect(await codeOf(service.startTotp(caller(), 'wrong'))).toBe(
        ACCOUNT_CODES.CURRENT_PASSWORD_INVALID,
      );
      expect(client.registerTotp).not.toHaveBeenCalled();

      client.checkPassword.mockResolvedValue('valid');
      await expect(service.startTotp(caller(), 'pw')).resolves.toEqual({
        uri: 'otpauth://x',
        secret: 'S',
      });
      expect(client.checkPassword).toHaveBeenLastCalledWith(
        'pat',
        'auth.example.com',
        SUB,
        'pw',
      );
    });

    it('sets up an app without a password on an account that has none', async () => {
      const { service, client } = build({ methods: ['IDP'] });
      await service.startTotp(caller());
      expect(client.checkPassword).not.toHaveBeenCalled();
      expect(client.registerTotp).toHaveBeenCalled();
    });

    it('removes the app only after the current password', async () => {
      const { service, client } = build();
      client.checkPassword.mockResolvedValue('invalid');
      expect(await codeOf(service.removeTotp(caller(), 'wrong'))).toBe(
        ACCOUNT_CODES.CURRENT_PASSWORD_INVALID,
      );
      expect(client.removeTotp).not.toHaveBeenCalled();
    });

    it('refuses a sensitive change for an account that has no password to confirm it with', async () => {
      const { service, client } = build({ methods: ['IDP'] });
      expect(await codeOf(service.removeTotp(caller(), 'x'))).toBe(
        ACCOUNT_CODES.NO_PASSWORD,
      );
      expect(client.checkPassword).not.toHaveBeenCalled();
    });

    it('answers 404 for a passkey or security key that is not on the caller’s account', async () => {
      const { service, client } = build();
      expect(
        await codeOf(service.removePasskey(caller(), 'someone-else', 'pw')),
      ).toBe(404);
      expect(
        await codeOf(service.removeSecurityKey(caller(), 'someone-else', 'pw')),
      ).toBe(404);
      expect(client.removePasskey).not.toHaveBeenCalled();
      expect(client.removeSecurityKey).not.toHaveBeenCalled();
      expect(client.checkPassword).not.toHaveBeenCalled();
    });

    it('removes the caller’s own passkey on the caller’s own user', async () => {
      const { service, client } = build();
      await service.removePasskey(caller(), 'pk-1', 'pw');
      expect(client.removePasskey).toHaveBeenCalledWith(
        'pat',
        'auth.example.com',
        SUB,
        'pk-1',
      );
    });
  });

  describe('linked sign-ins', () => {
    const link = { idpId: 'idp-gh', externalUserId: 'gh-1' };

    it('keeps a demo guest’s sign-in, whatever it sends', async () => {
      const { service, client } = build({ access: { isSandbox: true } });
      expect(await codeOf(service.unlink(caller(), link, 'pw'))).toBe(
        ACCOUNT_CODES.GUEST_KEEPS_SIGN_IN,
      );
      expect(client.removeIdpLink).not.toHaveBeenCalled();
      const view = await service.overview(caller());
      expect(view.limits).toEqual({ guest: true, canUnlink: false });
    });

    it('refuses to remove the only way in', async () => {
      const { service, client } = build({ methods: ['IDP'] });
      client.listPasskeys.mockResolvedValue([]);
      expect(await codeOf(service.unlink(caller(), link, 'pw'))).toBe(
        ACCOUNT_CODES.LAST_SIGN_IN_METHOD,
      );
      expect(client.removeIdpLink).not.toHaveBeenCalled();
    });

    it('answers 404 for a link that is not the caller’s', async () => {
      const { service, client } = build();
      expect(
        await codeOf(
          service.unlink(
            caller(),
            { idpId: 'idp-gh', externalUserId: 'x' },
            'pw',
          ),
        ),
      ).toBe(404);
      expect(client.removeIdpLink).not.toHaveBeenCalled();
    });

    it('unlinks after the current password when a password remains', async () => {
      const { service, client } = build({ methods: ['PASSWORD', 'IDP'] });
      await service.unlink(caller(), link, 'pw');
      expect(client.checkPassword).toHaveBeenCalled();
      expect(client.removeIdpLink).toHaveBeenCalledWith(
        'pat',
        'auth.example.com',
        SUB,
        { idpId: 'idp-gh', externalUserId: 'gh-1', externalUserName: 'ada' },
      );
    });
  });

  it('turns any other provider failure into a gateway error that names no internals', async () => {
    const { service, client } = build();
    client.getUser.mockRejectedValue(providerError(500, 'db exploded'));
    expect(await codeOf(service.overview(caller()))).toBe(
      ACCOUNT_CODES.PROVIDER_ERROR,
    );
  });
});
