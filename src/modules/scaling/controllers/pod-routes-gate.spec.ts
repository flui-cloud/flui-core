jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PodDebugController } from './pod-debug.controller';
import { CrashDiagnosesController } from './crash-diagnoses.controller';
import { AppAccessGuard } from '../../applications/guards/app-access.guard';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

const caller: AuthenticatedUser = {
  userId: 'user-a',
  email: 'a@example.com',
  roles: {},
  role: IdentityRole.USER,
  isAdmin: false,
};

const context = (
  params: Record<string, string>,
  method = 'GET',
): ExecutionContext =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ user: caller, params, method }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  }) as unknown as ExecutionContext;

/**
 * A guard that reads the wrong parameter name is worse than no guard: it finds
 * no id, decides the route is not app-scoped, and lets the call through. That
 * is how these two controllers were reachable — an operator read the pods,
 * containers, restart counts and Kubernetes events of a *guest's* application.
 * Mounting the guard and teaching it the third spelling only work together.
 */
describe('the pod-level routes of one application', () => {
  it('PodDebugController carries AppAccessGuard', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      PodDebugController,
    ) as unknown[];
    expect(guards).toContain(AppAccessGuard);
  });

  it('CrashDiagnosesController carries AppAccessGuard', () => {
    const guards = Reflect.getMetadata(
      '__guards__',
      CrashDiagnosesController,
    ) as unknown[];
    expect(guards).toContain(AppAccessGuard);
  });

  /**
   * Round E2 finished decision 46: the application is `:id` here as it is
   * everywhere else. On the crash-diagnoses controller that forced the nested
   * parameter to stop being `:id` too — two path parameters of the same name
   * collide and Express keeps the last, which would have handed the guard the
   * diagnosis id to check ownership on. Hence `:diagnosisId`.
   */
  it('both name the application :id', () => {
    expect(Reflect.getMetadata('path', PodDebugController)).toBe(
      'applications/:id/debug',
    );
    expect(Reflect.getMetadata('path', CrashDiagnosesController)).toBe(
      'applications/:id/crash-diagnoses',
    );
  });

  it('never names two path parameters of the same route the same thing', () => {
    const base = Reflect.getMetadata(
      'path',
      CrashDiagnosesController,
    ) as string;
    for (const method of ['list', 'getOne', 'dismiss'] as const) {
      const tail = Reflect.getMetadata(
        'path',
        CrashDiagnosesController.prototype[method],
      ) as string;
      const params = `${base}/${tail}`
        .split('/')
        .filter((seg) => seg.startsWith(':'));
      expect(new Set(params).size).toBe(params.length);
    }
  });
});

describe('AppAccessGuard and the three spellings of an application id', () => {
  const build = () => {
    const apps = { findById: jest.fn(async (id: string) => ({ id })) };
    const access = { assertCan: jest.fn().mockResolvedValue(undefined) };
    const reflector = {
      getAllAndOverride: jest.fn().mockReturnValue(undefined),
    };
    const guard = new AppAccessGuard(
      reflector as never,
      apps as never,
      access as never,
    );
    return { guard, apps, access };
  };

  it('reads :applicationId', async () => {
    const { guard, apps } = build();
    await guard.canActivate(context({ applicationId: 'app-1' }));
    expect(apps.findById).toHaveBeenCalledWith('app-1');
  });

  it('still reads :appId and :id', async () => {
    const { guard, apps } = build();
    await guard.canActivate(context({ appId: 'app-2' }));
    await guard.canActivate(context({ id: 'app-3' }));
    expect(apps.findById).toHaveBeenNthCalledWith(1, 'app-2');
    expect(apps.findById).toHaveBeenNthCalledWith(2, 'app-3');
  });

  /**
   * The reason the order is not cosmetic: on
   * `applications/:applicationId/crash-diagnoses/:id`, `:id` is the diagnosis.
   * Reading it first would load the wrong row and 404 a caller who is entitled.
   */
  it('prefers :applicationId when a sub-resource also occupies :id', async () => {
    const { guard, apps, access } = build();
    await guard.canActivate(
      context({ applicationId: 'app-1', id: 'diagnosis-9' }),
    );
    expect(apps.findById).toHaveBeenCalledWith('app-1');
    expect(apps.findById).not.toHaveBeenCalledWith('diagnosis-9');
    expect(access.assertCan).toHaveBeenCalledWith(
      caller,
      IAM_PERMISSION.APP_READ,
      { id: 'app-1' },
    );
  });

  it('asks for app:write on the dismiss, which is a POST', async () => {
    const { guard, access } = build();
    await guard.canActivate(
      context({ applicationId: 'app-1', id: 'diagnosis-9' }, 'POST'),
    );
    expect(access.assertCan).toHaveBeenCalledWith(
      caller,
      IAM_PERMISSION.APP_WRITE,
      { id: 'app-1' },
    );
  });

  it("refuses when the access service says the application is not the caller's", async () => {
    const { guard, access } = build();
    access.assertCan.mockRejectedValueOnce(new ForbiddenException('nope'));
    await expect(
      guard.canActivate(context({ applicationId: 'app-of-someone-else' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
