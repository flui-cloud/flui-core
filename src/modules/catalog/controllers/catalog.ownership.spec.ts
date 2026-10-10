jest.mock('@kubernetes/client-node', () => ({}));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { CatalogController } from './catalog.controller';

/** F-102: another tenant's building block is neither listed, reused nor read through its install. */
describe('catalog reuse and install reads respect ownership', () => {
  const apps: Record<string, { id: string; userId: string }> = {
    mine: { id: 'mine', userId: 'guest' },
    theirs: { id: 'theirs', userId: 'other' },
  };
  const access = {
    can: jest.fn(
      async (user: { userId: string }, _p: string, app: { userId: string }) =>
        app.userId === user.userId,
    ),
    assertCanCreate: jest.fn(async () => ({ isSandbox: true })),
  };
  const resolver = {
    findReusableInstances: jest.fn(
      async (
        _slug: string,
        _cluster: string,
        visible: (a: unknown[]) => Promise<unknown[]>,
      ) => visible(Object.values(apps)),
    ),
  };
  const installs = {
    findById: jest.fn(async (id: string) =>
      id === 'i-other'
        ? { id, userId: 'other', applicationIds: ['theirs'] }
        : null,
    ),
  };
  const installer = {
    install: jest.fn(async () => ({ install: { id: 'new' } })),
  };
  const controller = new CatalogController(
    {} as never,
    installer as never,
    resolver as never,
    installs as never,
    {} as never,
    access as never,
    { findById: jest.fn(async (id: string) => apps[id] ?? null) } as never,
  );
  const req = { user: { userId: 'guest', isAdmin: false } } as never;

  it('lists only the building blocks the caller may change', async () => {
    await expect(
      controller.listReusableInstances('postgresql', 'c1', req),
    ).resolves.toEqual([apps.mine]);
  });

  it('refuses to wire someone else’s building block into an install', async () => {
    await expect(
      controller.install(
        'umami',
        {
          clusterId: 'c1',
          dependencyChoices: [
            {
              as: 'db',
              mode: 'reuse_existing',
              existingApplicationId: 'theirs',
            },
          ],
        } as never,
        req,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(installer.install).not.toHaveBeenCalled();
  });

  it('does not show another person’s install', async () => {
    await expect(controller.getInstall('i-other', req)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
