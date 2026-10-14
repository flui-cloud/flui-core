import { ForbiddenException } from '@nestjs/common';
import {
  ACCOUNT_SECURITY_NEEDS_SIGN_IN_CODE,
  AccountController,
  AGENT_MAY_NOT_MANAGE_ACCOUNT_CODE,
} from './account.controller';
import { CURRENT_API_KEY_ID } from '../auth/strategies/api-key.strategy';
import { auditEntryFor } from '../audit/audit.middleware';
import { SensitivityRegistry } from '../mask/sensitivity.registry';
import { TotpRegistrationDto } from './dto/account.dto';

const person = {
  userId: 'local-1',
  email: 'ada@example.com',
  roles: {},
  role: 'user',
};

const build = () => {
  const account = {
    overview: jest.fn().mockResolvedValue({}),
    updateProfile: jest.fn().mockResolvedValue({}),
    changePassword: jest.fn().mockResolvedValue(undefined),
    startTotp: jest.fn().mockResolvedValue({ uri: 'u', secret: 's' }),
    verifyTotp: jest.fn().mockResolvedValue(undefined),
    removeTotp: jest.fn().mockResolvedValue(undefined),
    removePasskey: jest.fn().mockResolvedValue(undefined),
    removeSecurityKey: jest.fn().mockResolvedValue(undefined),
    unlink: jest.fn().mockResolvedValue(undefined),
  };
  return { controller: new AccountController(account as never), account };
};

describe('AccountController', () => {
  it('hands the service the authenticated caller, and nothing from the request', async () => {
    const { controller, account } = build();
    await controller.overview({ user: person, headers: {} } as never);
    expect(account.overview).toHaveBeenCalledWith(person);
  });

  it('refuses an agent credential on every route', async () => {
    const { controller, account } = build();
    const agent = {
      user: { ...person, scopes: ['mcp:app:read'] },
      headers: {},
    } as never;
    const attempt = () =>
      controller.changePassword(agent, {
        currentPassword: 'a',
        newPassword: 'b',
      });
    await expect(attempt()).rejects.toBeInstanceOf(ForbiddenException);
    await expect(attempt()).rejects.toMatchObject({
      response: { code: AGENT_MAY_NOT_MANAGE_ACCOUNT_CODE },
    });
    expect(() => controller.overview(agent)).toThrow(ForbiddenException);
    expect(account.changePassword).not.toHaveBeenCalled();
    expect(account.overview).not.toHaveBeenCalled();
  });

  it('lets an API key read the account and change its name, and nothing about how it signs in', async () => {
    const { controller, account } = build();
    const key = {
      user: person,
      headers: {},
      [CURRENT_API_KEY_ID]: 'key-1',
    } as never;
    await controller.overview(key);
    await controller.updateProfile(key, { firstName: 'A', lastName: 'L' });
    expect(account.overview).toHaveBeenCalled();
    expect(account.updateProfile).toHaveBeenCalled();

    const pw = { currentPassword: 'pw' };
    const attempts: Array<() => unknown> = [
      () => controller.changePassword(key, { ...pw, newPassword: 'n' }),
      () => controller.startTotp(key, pw),
      () => controller.verifyTotp(key, { code: '123456' }),
      () => controller.removeTotp(key, pw),
      () => controller.removePasskey(key, 'pk', pw),
      () => controller.removeSecurityKey(key, 'sk', pw),
      () => controller.removeLink(key, 'idp', 'ext', pw),
    ];
    for (const attempt of attempts) {
      await expect(Promise.resolve().then(attempt)).rejects.toMatchObject({
        response: { code: ACCOUNT_SECURITY_NEEDS_SIGN_IN_CODE },
      });
    }
    for (const fn of [
      account.changePassword,
      account.startTotp,
      account.verifyTotp,
      account.removeTotp,
      account.removePasskey,
      account.removeSecurityKey,
      account.unlink,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it('hands the current password to the authenticator set-up of a signed-in person', async () => {
    const { controller, account } = build();
    await controller.startTotp({ user: person, headers: {} } as never, {
      currentPassword: 'pw',
    });
    expect(account.startTotp).toHaveBeenCalledWith(person, 'pw');
  });

  it('passes the link named in the path, for the caller’s own account only', async () => {
    const { controller, account } = build();
    await controller.removeLink(
      { user: person, headers: {} } as never,
      'idp-gh',
      'gh-1',
      { currentPassword: 'pw' },
    );
    expect(account.unlink).toHaveBeenCalledWith(
      person,
      { idpId: 'idp-gh', externalUserId: 'gh-1' },
      'pw',
    );
  });

  it('leaves a record of every change, refused or not', () => {
    const entry = auditEntryFor(
      {
        user: person,
        route: { path: '/api/v1/account/links/:idpId/:externalUserId' },
        method: 'DELETE',
        params: { idpId: 'idp-gh', externalUserId: 'gh-1' },
        headers: {},
      } as never,
      400,
    );
    expect(entry).toMatchObject({
      userId: 'local-1',
      action: 'DELETE /account/links/:idpId/:externalUserId',
      target: { idpId: 'idp-gh', externalUserId: 'gh-1' },
      outcome: 'failed',
    });
    const password = auditEntryFor(
      {
        user: person,
        route: { path: '/api/v1/account/password' },
        method: 'POST',
        params: {},
        headers: {},
        body: { currentPassword: 'secret' },
      } as never,
      200,
    );
    expect(password).toMatchObject({
      action: 'POST /account/password',
      outcome: 'ok',
    });
    expect(JSON.stringify(password)).not.toContain('secret');
  });
});

describe('what the account routes hand out', () => {
  it('treats the authenticator secret as a credential shown once', () => {
    const registry = new SensitivityRegistry();
    expect(registry.sensitivityOf(TotpRegistrationDto, 'secret')).toBe(
      'credential',
    );
    expect(registry.sensitivityOf(TotpRegistrationDto, 'uri')).toBe(
      'credential',
    );
  });
});
