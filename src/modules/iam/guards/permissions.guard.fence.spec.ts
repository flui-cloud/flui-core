import { ForbiddenException } from '@nestjs/common';
import { PermissionsGuard } from './permissions.guard';
import {
  SANDBOX_FENCE_ADMITTED,
  SANDBOX_GUEST_REQUEST,
} from '../../sandbox/guards/sandbox-fence.guard';
import { IAM_PERMISSION } from '../constants/iam-permissions';

/** F-105: the fence lets a guest look at a shown section; on its own things the permissions still decide. */
describe('a guest read the fence admitted', () => {
  const guard = new PermissionsGuard(
    {
      getAllAndOverride: (key: string) =>
        key === 'iam:dataDoor' ? false : IAM_PERMISSION.CLUSTER_READ,
    } as never,
    { check: jest.fn(async () => false) } as never,
  );
  const ctx = (level: string) =>
    ({
      getHandler: () => undefined,
      getClass: () => undefined,
      switchToHttp: () => ({
        getRequest: () => ({
          method: 'GET',
          user: { userId: 'guest', isAdmin: false },
          [SANDBOX_GUEST_REQUEST]: { userId: 'guest' },
          [SANDBOX_FENCE_ADMITTED]: level,
        }),
      }),
    }) as never;

  it('passes on a section shown read-only or with examples', async () => {
    await expect(guard.canActivate(ctx('read-only'))).resolves.toBe(true);
    await expect(guard.canActivate(ctx('stand-in'))).resolves.toBe(true);
  });

  it('still asks for the permission on a route admitted as the guest’s own', async () => {
    await expect(guard.canActivate(ctx('full'))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
