jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { ExecutionContext, ForbiddenException, Type } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './guards/permissions.guard';
import { IAM_PERMISSION } from './constants/iam-permissions';
import { ServersController } from '../infrastructure/servers/servers.controller';
import { BackupArtifactsController } from '../backups/controllers/backup-artifacts.controller';

/**
 * A role that manages the platform but was not given `data:access` — the
 * platform operator — keeps every other permission a data door asks for, and
 * is still refused at the door.
 */
describe('PermissionsGuard on a @DataDoor route', () => {
  const context = (controller: Type<unknown>, method: string) =>
    ({
      getHandler: () =>
        (controller.prototype as Record<string, unknown>)[method],
      getClass: () => controller,
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          user: { userId: 'op', email: 'op@x', roles: {}, isAdmin: false },
        }),
      }),
    }) as unknown as ExecutionContext;

  const guard = (withheld: string[]) => {
    const check = jest.fn(
      async (_p: unknown, permission: string) => !withheld.includes(permission),
    );
    return {
      guard: new PermissionsGuard(new Reflector(), { check } as never),
      check,
    };
  };

  it('refuses a principal holding cluster:manage but not data:access', async () => {
    const { guard: g, check } = guard([IAM_PERMISSION.DATA_ACCESS]);

    await expect(
      g.canActivate(context(ServersController, 'getConsoleOutput')),
    ).rejects.toThrow(ForbiddenException);
    expect(check).toHaveBeenCalledWith(
      expect.anything(),
      IAM_PERMISSION.CLUSTER_MANAGE,
    );
    expect(check).toHaveBeenCalledWith(
      expect.anything(),
      IAM_PERMISSION.DATA_ACCESS,
    );
  });

  it('refuses the same principal at a door that asks nothing else', async () => {
    const { guard: g } = guard([IAM_PERMISSION.DATA_ACCESS]);

    await expect(
      g.canActivate(context(BackupArtifactsController, 'list')),
    ).rejects.toThrow('Missing required permission: data:access');
  });

  it('lets through a principal holding both', async () => {
    const { guard: g } = guard([]);

    await expect(
      g.canActivate(context(ServersController, 'getConsoleOutput')),
    ).resolves.toBe(true);
  });

  it('asks nothing new on a route that is not a door', async () => {
    const { guard: g, check } = guard([IAM_PERMISSION.DATA_ACCESS]);

    await expect(
      g.canActivate(context(ServersController, 'deleteServer')),
    ).resolves.toBe(true);
    expect(check).not.toHaveBeenCalledWith(
      expect.anything(),
      IAM_PERMISSION.DATA_ACCESS,
    );
  });
});
