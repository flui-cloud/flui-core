jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { ForbiddenException } from '@nestjs/common';
import { AppAccessGuard } from './app-access.guard';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';

/**
 * The guard allows any route where it cannot find an application id, on the
 * grounds that such a route is a list or a create and its handler enforces.
 * That default makes a spelling mismatch invisible: a route saying `:appId`
 * while the guard read only `:id` was decorated, looked protected, and let
 * everyone through. These tests pin the parameter names it must recognise.
 */
describe('AppAccessGuard parameter resolution', () => {
  const user: AuthenticatedUser = {
    userId: 'user-a',
    email: 'a@example.com',
    roles: {},
    role: IdentityRole.USER,
    isAdmin: false,
  };

  const build = () => {
    const asked: string[] = [];
    const apps = {
      findById: async (id: string) => {
        asked.push(id);
        return { id, userId: 'someone-else' };
      },
    };
    const access = {
      assertCan: async () => {
        throw new ForbiddenException('denied');
      },
    };
    const reflector = { getAllAndOverride: () => undefined };
    return {
      asked,
      guard: new AppAccessGuard(
        reflector as never,
        apps as never,
        access as never,
      ),
    };
  };

  const contextFor = (params: Record<string, string>) =>
    ({
      switchToHttp: () => ({
        getRequest: () => ({ user, params, method: 'GET' }),
      }),
      getHandler: () => undefined,
      getClass: () => undefined,
    }) as never;

  it('resolves the application from :id', async () => {
    const { guard, asked } = build();
    await expect(
      guard.canActivate(contextFor({ id: 'app-1' })),
    ).rejects.toThrow(ForbiddenException);
    expect(asked).toEqual(['app-1']);
  });

  it('resolves it from :appId too', async () => {
    const { guard, asked } = build();
    await expect(
      guard.canActivate(contextFor({ appId: 'app-2' })),
    ).rejects.toThrow(ForbiddenException);
    expect(asked).toEqual(['app-2']);
  });

  it('prefers :id when a route somehow carries both', async () => {
    const { guard, asked } = build();
    await expect(
      guard.canActivate(contextFor({ id: 'app-1', appId: 'app-2' })),
    ).rejects.toThrow(ForbiddenException);
    expect(asked).toEqual(['app-1']);
  });

  it('still falls through on a route with no application in its path', async () => {
    const { guard, asked } = build();
    await expect(
      guard.canActivate(contextFor({ clusterId: 'c1' })),
    ).resolves.toBe(true);
    expect(asked).toEqual([]);
  });
});
