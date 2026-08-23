import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { CREDENTIAL_CEILING_CODE, PermissionsGuard } from './permissions.guard';
import { IAM_PERMISSION } from '../constants/iam-permissions';
import { MCP_SCOPE } from '../../mcp/constants/mcp-scopes';
import { findPermissionGroup } from '../../auth/constants/api-key-groups';
import { credentialCeiling } from '../../auth/utils/credential-ceiling.util';

/**
 * The ceiling a credential declares, on the HTTP path.
 *
 * Every case here is written from the other side as well: the point of the
 * change is not that a scoped key loses something, it is that nothing WITHOUT a
 * ceiling loses anything. An interactive OIDC session, the CLI key and the
 * service identities all arrive here with no `mcp:*` scope and must come out
 * exactly as they went in.
 */

const APPS_CHANGE = findPermissionGroup('apps:change')?.scopes ?? [];

const context = (user: Record<string, unknown> | undefined): ExecutionContext =>
  ({
    getHandler: () => undefined,
    getClass: () => undefined,
    switchToHttp: () => ({
      getRequest: () => ({ method: 'DELETE', user, path: '/iam/bindings/x' }),
    }),
  }) as unknown as ExecutionContext;

/** The policy engine says yes to everything: only the ceiling can refuse here. */
const guardFor = (required: string | undefined) =>
  new PermissionsGuard(
    { getAllAndOverride: () => required } as never,
    { check: async () => true } as never,
  );

describe('PermissionsGuard — the credential ceiling', () => {
  it('refuses a permission the credential scopes do not carry', async () => {
    const guard = guardFor(IAM_PERMISSION.IAM_ASSIGN_ROLE);
    await expect(
      guard.canActivate(
        context({
          userId: 'u1',
          email: 'a@x',
          isAdmin: true,
          scopes: APPS_CHANGE,
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  it('names the ceiling rather than the IAM refusal', async () => {
    const guard = guardFor(IAM_PERMISSION.CLUSTER_DESTROY);
    await expect(
      guard.canActivate(
        context({
          userId: 'u1',
          email: 'a@x',
          isAdmin: true,
          scopes: APPS_CHANGE,
        }),
      ),
    ).rejects.toMatchObject({ response: { code: CREDENTIAL_CEILING_CODE } });
  });

  it('lets through a permission the scopes do carry', async () => {
    const guard = guardFor(IAM_PERMISSION.APP_WRITE);
    await expect(
      guard.canActivate(
        context({ userId: 'u1', email: 'a@x', scopes: APPS_CHANGE }),
      ),
    ).resolves.toBe(true);
  });

  it('does not cap an administrator holding an unscoped credential', async () => {
    const guard = guardFor(IAM_PERMISSION.CLUSTER_DESTROY);
    await expect(
      guard.canActivate(
        context({ userId: 'u1', email: 'a@x', isAdmin: true, scopes: null }),
      ),
    ).resolves.toBe(true);
  });

  it('does not read an OIDC session as a ceiling', async () => {
    // What `jwt.strategy.ts` puts on the principal from `payload.scope`.
    const guard = guardFor(IAM_PERMISSION.IAM_MANAGE_USERS);
    await expect(
      guard.canActivate(
        context({
          userId: 'u1',
          email: 'a@x',
          scopes: ['openid', 'profile', 'email'],
        }),
      ),
    ).resolves.toBe(true);
  });

  it('applies a ceiling that arrived as identity-provider roles', async () => {
    // Decision 74 part 2 mints `mcp:*` project roles; they land in `roles`,
    // never in `scopes`, and the ceiling has to be blind to the difference.
    const guard = guardFor(IAM_PERMISSION.CLUSTER_DESTROY);
    await expect(
      guard.canActivate(
        context({
          userId: 'u1',
          email: 'a@x',
          isAdmin: true,
          roles: { [MCP_SCOPE.APP_READ]: {} },
        }),
      ),
    ).rejects.toMatchObject({ response: { code: CREDENTIAL_CEILING_CODE } });
  });

  it('leaves a route with no @RequirePermission alone', async () => {
    // The coverage rule of decision 74 is NOT applied: see decision 77. Every
    // converted MCP tool lands on a route with no @RequirePermission, so a
    // blanket refusal here would take the whole toolbox away from every agent.
    const guard = guardFor(undefined);
    await expect(
      guard.canActivate(
        context({ userId: 'u1', email: 'a@x', scopes: APPS_CHANGE }),
      ),
    ).resolves.toBe(true);
  });
});

describe('credentialCeiling — null is not the empty set', () => {
  it('reads a missing scopes column as no ceiling at all', () => {
    expect(credentialCeiling({ scopes: undefined })).toBeNull();
    expect(credentialCeiling(undefined)).toBeNull();
  });

  it('reads an unrecognised mcp scope as a ceiling that allows nothing', () => {
    expect(credentialCeiling({ scopes: ['mcp:not:a:scope'] })?.size).toBe(0);
  });

  /**
   * It used to be the inversion of the minting table, and decision 77 says why
   * that was the wrong table: "what you must hold to confer this scope" and
   * "what this scope lets you do" are different questions. Inverted,
   * `apps:change` came out as `{app:read, app:write}` — no `app:create`, no
   * `app:deploy`, no `scale:execute` — so the group whose one sentence is
   * "Deploy and operate applications" would have been refused the deploy.
   */
  it('reads the allows column, not the inversion of requires', () => {
    expect(
      [...(credentialCeiling({ scopes: APPS_CHANGE }) ?? [])].sort(),
    ).toEqual(
      [
        IAM_PERMISSION.APP_READ,
        IAM_PERMISSION.APP_WRITE,
        IAM_PERMISSION.APP_CREATE,
        IAM_PERMISSION.APP_DEPLOY,
        IAM_PERMISSION.SCALE_EXECUTE,
        IAM_PERMISSION.CLUSTER_READ,
      ].sort(),
    );
  });

  it('does not hand the delete to a key that only operates', () => {
    expect(
      credentialCeiling({ scopes: APPS_CHANGE })?.has(
        IAM_PERMISSION.APP_DELETE,
      ),
    ).toBe(false);
    expect(
      credentialCeiling({ scopes: [MCP_SCOPE.APP_DESTRUCTIVE] })?.has(
        IAM_PERMISSION.APP_DELETE,
      ),
    ).toBe(true);
  });

  /**
   * `requires` pins mail and backups to `cluster:manage` because that is the
   * permission governing the section the same data is shown in. Inverted, that
   * pin turned "read the mail log" into "manage a cluster".
   */
  it('does not lend the manage permission to a read scope', () => {
    expect(
      credentialCeiling({ scopes: [MCP_SCOPE.MAIL_READ] })?.has(
        IAM_PERMISSION.CLUSTER_MANAGE,
      ),
    ).toBe(false);
    expect(
      credentialCeiling({ scopes: [MCP_SCOPE.BACKUP_READ] })?.has(
        IAM_PERMISSION.CLUSTER_MANAGE,
      ),
    ).toBe(false);
    expect(
      credentialCeiling({ scopes: [MCP_SCOPE.BACKUP_WRITE] })?.has(
        IAM_PERMISSION.CLUSTER_MANAGE,
      ),
    ).toBe(true);
  });
});
