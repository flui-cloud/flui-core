jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { ForbiddenException } from '@nestjs/common';
import { AppAccessGuard } from './app-access.guard';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { DATA_DOOR_KEY } from '../../iam/decorators/data-door.decorator';
import { OPEN_ON_SHOWCASE_KEY } from '../../iam/decorators/open-on-showcase.decorator';
import { SHOWCASE_TAG } from '../../iam/constants/iam-showcase';

/**
 * A guest who looks at the showcase may read its logs and crash diagnoses,
 * which the operator put on display; every other data door on the same
 * application, and the same door on any other application, still asks for
 * `data:access`.
 */
describe('AppAccessGuard on the showcase', () => {
  const guest: AuthenticatedUser = {
    userId: 'guest',
    email: 'guest@example.com',
    roles: {},
    role: IdentityRole.USER,
    isAdmin: false,
  };

  const run = async (opts: { tags: string[]; openOnShowcase: boolean }) => {
    const asked: string[] = [];
    const guard = new AppAccessGuard(
      {
        getAllAndOverride: (key: string) =>
          ({
            [DATA_DOOR_KEY]: true,
            [OPEN_ON_SHOWCASE_KEY]: opts.openOnShowcase,
          })[key],
      } as never,
      { findById: async (id: string) => ({ id, tags: opts.tags }) } as never,
      {
        assertCan: async (_user: unknown, permission: string) => {
          asked.push(permission);
          if (permission === IAM_PERMISSION.DATA_ACCESS) {
            throw new ForbiddenException('no data access');
          }
        },
      } as never,
    );
    const context = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: guest,
          params: { id: 'a1' },
          method: 'GET',
        }),
      }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as never;
    const outcome = await guard.canActivate(context).then(
      () => 'allowed',
      () => 'refused',
    );
    return { outcome, asked };
  };

  it('reads logs of an application in the showcase with app:read alone', async () => {
    const { outcome, asked } = await run({
      tags: [SHOWCASE_TAG],
      openOnShowcase: true,
    });
    expect(outcome).toBe('allowed');
    expect(asked).toEqual([IAM_PERMISSION.APP_READ]);
  });

  it('keeps the other data doors of a showcase application closed', async () => {
    const { outcome } = await run({
      tags: [SHOWCASE_TAG],
      openOnShowcase: false,
    });
    expect(outcome).toBe('refused');
  });

  it('keeps the same door closed on an application outside the showcase', async () => {
    const { outcome } = await run({ tags: [], openOnShowcase: true });
    expect(outcome).toBe('refused');
  });
});
