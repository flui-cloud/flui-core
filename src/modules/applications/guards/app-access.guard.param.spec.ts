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

  it('resolves it from :applicationId too', async () => {
    const { guard, asked } = build();
    await expect(
      guard.canActivate(contextFor({ applicationId: 'app-3' })),
    ).rejects.toThrow(ForbiddenException);
    expect(asked).toEqual(['app-3']);
  });

  /**
   * The order changed, and the reason is a route rather than a preference.
   * Every path that spells the application `:appId` or `:applicationId` — all
   * seven of them, checked against the route table — nests its sub-resource
   * under `:id`: on `applications/:applicationId/crash-diagnoses/:id`, `:id` is
   * the diagnosis. Reading `id` first there would load the wrong row and answer
   * 404 to a caller who is entitled to the route. No route behind this guard
   * carries `:appId` or `:applicationId` meaning anything but the application.
   */
  it('prefers the explicit spelling when a sub-resource occupies :id', async () => {
    const { guard, asked } = build();
    await expect(
      guard.canActivate(contextFor({ applicationId: 'app-1', id: 'diag-9' })),
    ).rejects.toThrow(ForbiddenException);
    expect(asked).toEqual(['app-1']);

    const second = build();
    await expect(
      second.guard.canActivate(contextFor({ appId: 'app-2', id: 'sub-9' })),
    ).rejects.toThrow(ForbiddenException);
    expect(second.asked).toEqual(['app-2']);
  });

  it('still falls through on a route with no application in its path', async () => {
    const { guard, asked } = build();
    await expect(
      guard.canActivate(contextFor({ clusterId: 'c1' })),
    ).resolves.toBe(true);
    expect(asked).toEqual([]);
  });
});
