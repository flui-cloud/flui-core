jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { ForbiddenException } from '@nestjs/common';
import { CatalogController } from './catalog.controller';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

/**
 * Connecting a client wires the target building block's credentials into the
 * client's pod, so the target is as much the subject of the act as the client.
 */
describe('connecting a catalog client to a building block', () => {
  const clientApp = { id: 'client-app', slug: 'pgweb' };
  const targetApp = { id: 'target-app', slug: 'postgres' };
  const installs: Record<
    string,
    { id: string; userId: string; applicationIds: string[] }
  > = {
    client: { id: 'client', userId: 'u1', applicationIds: ['client-app'] },
    target: {
      id: 'target',
      userId: 'someone-else',
      applicationIds: ['target-app'],
    },
  };

  const build = (mayWrite: (app: { id: string }) => boolean) => {
    const installer = {
      connect: jest.fn(async (id: string) => installs[id]),
      disconnect: jest.fn(async (id: string) => installs[id]),
    };
    const assertCan = jest.fn(
      async (_u: unknown, _a: string, app: { id: string }) => {
        if (!mayWrite(app)) throw new ForbiddenException('no');
      },
    );
    const controller = new CatalogController(
      {
        resolveConnectedTarget: jest.fn(async () => null),
      } as never,
      installer as never,
      {} as never,
      {
        findById: jest.fn(async (id: string) => installs[id] ?? null),
      } as never,
      {} as never,
      { assertCan } as never,
      {
        findById: jest.fn(async (id: string) =>
          id === clientApp.id
            ? clientApp
            : id === targetApp.id
              ? targetApp
              : null,
        ),
      } as never,
    );
    return { controller, installer, assertCan };
  };
  const req = { user: { userId: 'u1' } } as never;

  it('refuses to link a building block the caller may not write', async () => {
    const { controller, installer } = build((app) => app.id !== 'target-app');

    await expect(
      controller.connect('client', { targetInstallId: 'target' }, req),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(installer.connect).not.toHaveBeenCalled();
  });

  it('asks app:write on both the client and the target', async () => {
    const { controller, installer, assertCan } = build(() => true);

    await controller.connect('client', { targetInstallId: 'target' }, req);

    expect(assertCan).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      IAM_PERMISSION.APP_WRITE,
      clientApp,
    );
    expect(assertCan).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1' }),
      IAM_PERMISSION.APP_WRITE,
      targetApp,
    );
    expect(installer.connect).toHaveBeenCalled();
  });

  it('refuses to disconnect a client the caller may not write', async () => {
    const { controller, installer } = build((app) => app.id !== 'client-app');

    await expect(controller.disconnect('client', req)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(installer.disconnect).not.toHaveBeenCalled();
  });
});
