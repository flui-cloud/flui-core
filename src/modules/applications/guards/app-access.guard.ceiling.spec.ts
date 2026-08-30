jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { ForbiddenException } from '@nestjs/common';
import { AppAccessGuard } from './app-access.guard';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IdentityRole } from '../../auth/entities/user.entity';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { MCP_SCOPE } from '../../mcp/constants/mcp-scopes';
import { findPermissionGroup } from '../../auth/constants/api-key-groups';
import {
  APPLICATION_CEILING_CODE,
  CREDENTIAL_CEILING_CODE,
} from '../../auth/utils/credential-ceiling.util';

/**
 * The credential ceiling on the guard that actually governs applications.
 *
 * `@RequirePermission` names no `app:*` permission anywhere in the product, so
 * a ceiling living only in `PermissionsGuard` never met a single application
 * route. Everything below is written from both sides: what a scoped key loses,
 * and — the part that matters more — that a credential declaring no `mcp:*`
 * scope comes out exactly as it went in.
 */

const APPS_CHANGE = findPermissionGroup('apps:change')!.scopes;
const APPS_DESTROY = findPermissionGroup('apps:destroy')!.scopes;
const APPS_LOOK = findPermissionGroup('apps:look')!.scopes;

const principal = (over: Partial<AuthenticatedUser>): AuthenticatedUser => ({
  userId: 'user-a',
  email: 'a@example.com',
  roles: {},
  role: IdentityRole.USER,
  isAdmin: false,
  ...over,
});

/** IAM says yes to everything and the app exists: only the ceiling can refuse. */
const build = () => {
  const loaded: string[] = [];
  const asked: string[] = [];
  const apps = {
    findById: async (id: string) => {
      loaded.push(id);
      return { id, slug: 'app', userId: 'user-a' };
    },
  };
  const access = {
    assertCan: async (_u: unknown, action: string) => {
      asked.push(action);
    },
  };
  return {
    loaded,
    asked,
    guard: new AppAccessGuard(
      { getAllAndOverride: () => undefined } as never,
      apps as never,
      access as never,
    ),
  };
};

/** Same, with an explicit @AppAction on the route. */
const buildWithAction = (action: string) => {
  const base = build();
  return {
    ...base,
    guard: new AppAccessGuard(
      { getAllAndOverride: () => action } as never,
      {
        findById: async (id: string) => ({ id, slug: 'app', userId: 'user-a' }),
      } as never,
      {
        assertCan: async (_u: unknown, a: string) => base.asked.push(a),
      } as never,
    ),
  };
};

const ctx = (user: AuthenticatedUser | undefined, method = 'DELETE') =>
  ({
    switchToHttp: () => ({
      getRequest: () => ({ user, params: { id: 'app-1' }, method }),
    }),
    getHandler: () => undefined,
    getClass: () => undefined,
  }) as never;

describe('AppAccessGuard — the credential ceiling', () => {
  it('refuses the delete to a key minted for apps:change', async () => {
    const { guard, loaded } = buildWithAction(IAM_PERMISSION.APP_DELETE);
    await expect(
      guard.canActivate(ctx(principal({ scopes: [...APPS_CHANGE] }))),
    ).rejects.toMatchObject({ response: { code: CREDENTIAL_CEILING_CODE } });
    // And it never went looking for the row: the answer does not depend on it.
    expect(loaded).toEqual([]);
  });

  it('lets the delete through for a key minted for apps:destroy', async () => {
    const { guard, asked } = buildWithAction(IAM_PERMISSION.APP_DELETE);
    await expect(
      guard.canActivate(ctx(principal({ scopes: [...APPS_DESTROY] }))),
    ).resolves.toBe(true);
    expect(asked).toEqual([IAM_PERMISSION.APP_DELETE]);
  });

  /**
   * The trap decision 77 names. `apps:change` projects onto `app:write` under
   * the old inverted table, and a rollback asks for `app:deploy` — so a ceiling
   * built from `requires` would have refused the very deploy the group exists
   * to permit.
   */
  it('carries the deploy, the create and the scale that apps:change promises', async () => {
    for (const action of [
      IAM_PERMISSION.APP_DEPLOY,
      IAM_PERMISSION.APP_CREATE,
      IAM_PERMISSION.SCALE_EXECUTE,
      IAM_PERMISSION.APP_WRITE,
    ]) {
      const { guard } = buildWithAction(action);
      await expect(
        guard.canActivate(ctx(principal({ scopes: [...APPS_CHANGE] }))),
      ).resolves.toBe(true);
    }
  });

  it('refuses every write to a read-only key', async () => {
    const { guard } = build();
    await expect(
      guard.canActivate(ctx(principal({ scopes: [...APPS_LOOK] }), 'PATCH')),
    ).rejects.toMatchObject({ response: { code: CREDENTIAL_CEILING_CODE } });
  });

  it('still lets that read-only key read', async () => {
    const { guard, asked } = build();
    await expect(
      guard.canActivate(ctx(principal({ scopes: [...APPS_LOOK] }), 'GET')),
    ).resolves.toBe(true);
    expect(asked).toEqual([IAM_PERMISSION.APP_READ]);
  });

  it('caps an administrator holding a scoped key', async () => {
    // The whole point of a ceiling: least privilege on the credential, even
    // when the person behind it can do anything.
    const { guard } = buildWithAction(IAM_PERMISSION.APP_DELETE);
    await expect(
      guard.canActivate(
        ctx(principal({ isAdmin: true, scopes: [...APPS_CHANGE] })),
      ),
    ).rejects.toMatchObject({ response: { code: CREDENTIAL_CEILING_CODE } });
  });

  it('leaves an administrator holding an unscoped credential alone', async () => {
    const { guard, loaded } = buildWithAction(IAM_PERMISSION.APP_DELETE);
    await expect(
      guard.canActivate(ctx(principal({ isAdmin: true, scopes: undefined }))),
    ).resolves.toBe(true);
    expect(loaded).toEqual([]); // admin short-circuit, unchanged
  });

  it('leaves the sandbox session cookie alone — it declares no scopes', async () => {
    const { guard, asked } = build();
    await expect(
      guard.canActivate(ctx(principal({ scopes: undefined }), 'POST')),
    ).resolves.toBe(true);
    expect(asked).toEqual([IAM_PERMISSION.APP_WRITE]);
  });

  it('does not read an OIDC session as a ceiling', async () => {
    const { guard, asked } = build();
    await expect(
      guard.canActivate(
        ctx(principal({ scopes: ['openid', 'profile', 'email'] }), 'POST'),
      ),
    ).resolves.toBe(true);
    expect(asked).toEqual([IAM_PERMISSION.APP_WRITE]);
  });

  it('applies a ceiling that arrived as identity-provider roles', async () => {
    const { guard } = buildWithAction(IAM_PERMISSION.APP_DELETE);
    await expect(
      guard.canActivate(
        ctx(principal({ roles: { [MCP_SCOPE.APP_READ]: {} } })),
      ),
    ).rejects.toMatchObject({ response: { code: CREDENTIAL_CEILING_CODE } });
  });

  it('steps aside on a route with no application in its path', async () => {
    const { guard } = build();
    const noApp = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: principal({ scopes: [...APPS_LOOK] }),
          params: { clusterId: 'c1' },
          method: 'DELETE',
        }),
      }),
      getHandler: () => undefined,
      getClass: () => undefined,
    } as never;
    await expect(guard.canActivate(noApp)).resolves.toBe(true);
  });

  it('still refuses an unauthenticated request first', async () => {
    const { guard } = build();
    await expect(guard.canActivate(ctx(undefined))).rejects.toThrow(
      ForbiddenException,
    );
  });
});

/**
 * The application ceiling: a key limited to specific applications, on top of
 * (not instead of) the scope ceiling above and the ownership check below it.
 * `ctx()` always names `app-1` in the path, so `applicationIds` including or
 * excluding that one id is the whole of what each case turns on.
 */
describe('AppAccessGuard — the application ceiling', () => {
  it("refuses an application outside the key's list, distinctly from a scope refusal", async () => {
    const { guard, loaded } = build();
    await expect(
      guard.canActivate(
        ctx(principal({ applicationIds: ['app-2', 'app-3'] }), 'GET'),
      ),
    ).rejects.toMatchObject({ response: { code: APPLICATION_CEILING_CODE } });
    // Refused before the row was ever loaded, same as the scope ceiling above.
    expect(loaded).toEqual([]);
  });

  it('lets the application inside the list through', async () => {
    const { guard, asked } = build();
    await expect(
      guard.canActivate(ctx(principal({ applicationIds: ['app-1'] }), 'GET')),
    ).resolves.toBe(true);
    expect(asked).toEqual([IAM_PERMISSION.APP_READ]);
  });

  it('leaves a key with no application list unrestricted', async () => {
    const { guard, asked } = build();
    await expect(
      guard.canActivate(ctx(principal({ applicationIds: undefined }), 'GET')),
    ).resolves.toBe(true);
    expect(asked).toEqual([IAM_PERMISSION.APP_READ]);
  });

  it('caps an administrator holding an application-scoped key', async () => {
    // Same reasoning as the scope ceiling: the account most likely to mint
    // these keys, for its own apps, must not be the one case where the
    // restriction never actually held.
    const { guard, loaded } = build();
    await expect(
      guard.canActivate(
        ctx(principal({ isAdmin: true, applicationIds: ['app-2'] }), 'GET'),
      ),
    ).rejects.toMatchObject({ response: { code: APPLICATION_CEILING_CODE } });
    expect(loaded).toEqual([]);
  });

  it('names the requested application id in the refusal message', async () => {
    const { guard } = build();
    await expect(
      guard.canActivate(ctx(principal({ applicationIds: ['app-2'] }), 'GET')),
    ).rejects.toMatchObject({
      response: { message: expect.stringContaining('app-1') },
    });
  });

  it('is asked before the scope ceiling has anything left to refuse', async () => {
    // A key that passes the scope ceiling can still be stopped by the
    // application one — the two compose, neither substitutes for the other.
    const { guard } = buildWithAction(IAM_PERMISSION.APP_DELETE);
    await expect(
      guard.canActivate(
        ctx(
          principal({ scopes: [...APPS_DESTROY], applicationIds: ['app-2'] }),
        ),
      ),
    ).rejects.toMatchObject({ response: { code: APPLICATION_CEILING_CODE } });
  });
});
