import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { SectionAccessGuard } from './section-access.guard';
import { SectionAccess } from '../constants/iam-sections';

/**
 * The read-only level is only worth having if the API enforces it. A disabled
 * button in the browser is a suggestion; this is the thing that says no to the
 * same credential used from a script.
 */
const context = (
  method: string,
  required: string | undefined,
  user: Record<string, unknown> | undefined = { userId: 'u1', email: 'g@x' },
): ExecutionContext =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({ method, user, path: '/backup-policies' }),
    }),
  }) as unknown as ExecutionContext;

const guardFor = (granted: SectionAccess[], required = 'backup') => {
  const reflector = {
    getAllAndOverride: (key: string) => (key === 'isPublic' ? false : required),
  };
  const policy = { resolveSectionAccess: async () => granted };
  return new SectionAccessGuard(reflector as never, policy as never);
};

describe('SectionAccessGuard — the read-only level', () => {
  it('lets a GET through a read-only section', async () => {
    const guard = guardFor([{ key: 'backup', level: 'read-only' }]);
    await expect(guard.canActivate(context('GET', 'backup'))).resolves.toBe(
      true,
    );
  });

  it('refuses every verb that would change something', async () => {
    const guard = guardFor([{ key: 'backup', level: 'read-only' }]);
    for (const verb of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      await expect(guard.canActivate(context(verb, 'backup'))).rejects.toThrow(
        ForbiddenException,
      );
    }
  });

  it('says which limit it is, not just "forbidden"', async () => {
    const guard = guardFor([{ key: 'backup', level: 'read-only' }]);
    await expect(
      guard.canActivate(context('POST', 'backup')),
    ).rejects.toMatchObject({
      response: { code: 'SECTION_READ_ONLY' },
    });
  });

  it('leaves a full section alone', async () => {
    const guard = guardFor([{ key: 'backup', level: 'full' }]);
    await expect(guard.canActivate(context('POST', 'backup'))).resolves.toBe(
      true,
    );
  });

  it('still refuses a section that was not granted at all', async () => {
    const guard = guardFor([{ key: 'workloads', level: 'full' }]);
    await expect(guard.canActivate(context('GET', 'backup'))).rejects.toThrow(
      'Section not available: backup',
    );
  });

  it('is a pass-through where no section is required', async () => {
    const reflector = { getAllAndOverride: () => undefined };
    const policy = {
      resolveSectionAccess: async () => {
        throw new Error('must not be asked');
      },
    };
    const guard = new SectionAccessGuard(reflector as never, policy as never);
    await expect(guard.canActivate(context('POST', undefined))).resolves.toBe(
      true,
    );
  });

  /**
   * A handler declared @Public() under a controller that requires a section: the
   * section is inherited, not intended. JwtAuthGuard lets it through with no
   * user, and this guard used to answer "Unauthenticated" — which is how the
   * provider logo, deliberately public, was 403 for everybody, signed in or not.
   */
  it('lets a public handler through, with nobody signed in', async () => {
    const reflector = {
      getAllAndOverride: (key: string) =>
        key === 'isPublic' ? true : 'providers',
    };
    const policy = {
      resolveSectionAccess: async () => {
        throw new Error('must not be asked');
      },
    };
    const guard = new SectionAccessGuard(reflector as never, policy as never);
    await expect(
      guard.canActivate(context('GET', 'providers', undefined)),
    ).resolves.toBe(true);
  });

  it('admin is untouched by the level', async () => {
    const reflector = {
      getAllAndOverride: (key: string) =>
        key === 'isPublic' ? false : 'backup',
    };
    const policy = {
      resolveSectionAccess: async () => {
        throw new Error('must not be asked');
      },
    };
    const guard = new SectionAccessGuard(reflector as never, policy as never);
    await expect(
      guard.canActivate(
        context('DELETE', 'backup', { userId: 'a', isAdmin: true }),
      ),
    ).resolves.toBe(true);
  });
});
