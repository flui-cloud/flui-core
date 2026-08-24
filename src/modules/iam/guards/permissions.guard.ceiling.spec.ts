import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { CREDENTIAL_CEILING_CODE, PermissionsGuard } from './permissions.guard';
import { IAM_PERMISSION } from '../constants/iam-permissions';
import { MCP_SCOPE } from '../../mcp/constants/mcp-scopes';
import { findPermissionGroup } from '../../auth/constants/api-key-groups';
import {
  credentialCeiling,
  projectRolesOf,
} from '../../auth/utils/credential-ceiling.util';

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

  /**
   * The sharp edge of "the ceiling is blind to where the scopes came from",
   * pinned so nobody discovers it in production.
   *
   * A Flui rung and an agent scope are two different halves of the provider's
   * vocabulary and the guard reads them differently on purpose: the rung is
   * *access* and goes to the policy engine, the `mcp:*` role is a *ceiling* and
   * refuses before the engine is asked. Grant both to one identity and the
   * ceiling wins, because a ceiling can only take away — so an `mcp:*` project
   * role granted to a **person** makes their browser session least-privilege
   * too. That is the correct reading of least privilege on a credential, and it
   * is also why those roles are meant for machine users: an agent gets an
   * identity of its own rather than a cap on somebody's login.
   */
  it('caps a person who was granted an agent scope in the provider', async () => {
    const guard = guardFor(IAM_PERMISSION.CLUSTER_DESTROY);
    await expect(
      guard.canActivate(
        context({
          userId: 'u1',
          email: 'a@x',
          // The rung says owner; the agent scope says read-only.
          roles: { owner: {}, [MCP_SCOPE.APP_READ]: {} },
        }),
      ),
    ).rejects.toMatchObject({ response: { code: CREDENTIAL_CEILING_CODE } });
  });

  it('leaves the rung alone when no agent scope is claimed with it', async () => {
    const guard = guardFor(IAM_PERMISSION.CLUSTER_DESTROY);
    await expect(
      guard.canActivate(
        context({ userId: 'u1', email: 'a@x', roles: { owner: {} } }),
      ),
    ).resolves.toBe(true);
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

/**
 * Decision 112, and the part of it that could be fixed without breaking the
 * part that is right.
 *
 * A person handed an `mcp:*` project role in the identity provider — because
 * somebody meant it for her agent — finds her own dashboard turned read-only.
 * The ceiling behaving that way is decision 74 working: a credential that
 * declares a ceiling is worth that ceiling wherever it is presented, and a rule
 * that asked where the scopes came from would be a second rule for the same
 * boundary. So the enforcement stays exactly as it is, and what changes is that
 * the refusal now says which of the two things happened.
 */
describe('a ceiling that arrived from the identity provider says so', () => {
  const refusal = async (user: Record<string, unknown>) => {
    const guard = guardFor(IAM_PERMISSION.APP_WRITE);
    try {
      await guard.canActivate(context(user));
      throw new Error('expected a refusal');
    } catch (error) {
      return (error as ForbiddenException).getResponse() as {
        code: string;
        message: string;
      };
    }
  };

  it('refuses a person exactly as it refuses a key — the boundary does not move', async () => {
    const fromRole = await refusal({
      userId: 'u1',
      email: 'a@x',
      isAdmin: true,
      roles: { [MCP_SCOPE.APP_READ]: {} },
    });
    const fromKey = await refusal({
      userId: 'u1',
      email: 'a@x',
      isAdmin: true,
      scopes: [MCP_SCOPE.APP_READ],
    });
    expect(fromRole.code).toBe(CREDENTIAL_CEILING_CODE);
    expect(fromKey.code).toBe(CREDENTIAL_CEILING_CODE);
  });

  it('tells the person where the cap came from and what to do instead', async () => {
    const body = await refusal({
      userId: 'u1',
      email: 'a@x',
      isAdmin: true,
      roles: { [MCP_SCOPE.APP_READ]: {} },
    });
    expect(body.message).toContain('identity provider');
    expect(body.message).toContain('machine account');
  });

  it('says nothing of the sort when the cap is an ordinary scoped key', async () => {
    const body = await refusal({
      userId: 'u1',
      email: 'a@x',
      isAdmin: true,
      scopes: [MCP_SCOPE.APP_READ],
    });
    expect(body.message).not.toContain('identity provider');
  });
});

/**
 * The claim an agent identity's token actually carries.
 *
 * Measured against the real provider rather than assumed: a machine user
 * obtaining a token by `client_credentials` gets its project roles under
 * `urn:zitadel:iam:org:project:<projectId>:roles`, never under the unprefixed
 * name a browser login carries. Reading only the unprefixed one left `roles`
 * empty, and an empty `roles` is not a narrow ceiling — it is **no ceiling**,
 * which is the one direction a ceiling must never fail in.
 */
describe('project roles arrive under two different claims', () => {
  const HUMAN = 'urn:zitadel:iam:org:project:roles';
  const MACHINE = 'urn:zitadel:iam:org:project:386547186109775904:roles';

  it('reads the claim a browser login carries', () => {
    expect(
      Object.keys(projectRolesOf({ [HUMAN]: { maintainer: { o: 'acme' } } })),
    ).toEqual(['maintainer']);
  });

  it('reads the claim a machine identity carries', () => {
    expect(
      Object.keys(projectRolesOf({ [MACHINE]: { [MCP_SCOPE.APP_READ]: {} } })),
    ).toEqual([MCP_SCOPE.APP_READ]);
  });

  it('unions them when a token somehow carries both', () => {
    expect(
      Object.keys(
        projectRolesOf({
          [HUMAN]: { viewer: {} },
          [MACHINE]: { [MCP_SCOPE.APP_READ]: {} },
        }),
      ).sort(),
    ).toEqual([MCP_SCOPE.APP_READ, 'viewer'].sort());
  });

  it('is empty for a token that names no roles at all, exactly as before', () => {
    expect(projectRolesOf({ sub: 'u1', aud: 'x' })).toEqual({});
    expect(projectRolesOf(undefined)).toEqual({});
  });

  it('does not mistake a neighbouring claim for a role claim', () => {
    expect(
      projectRolesOf({
        'urn:zitadel:iam:org:project:386547186109775904:roles:extra': {
          nope: {},
        },
        'urn:zitadel:iam:org:projects:roles': { alsoNope: {} },
      }),
    ).toEqual({});
  });

  /**
   * The whole point, end to end: the scope the identity was minted with becomes
   * the ceiling it is held to, instead of vanishing into an empty `roles`.
   */
  it('turns a machine identity’s granted scope into the ceiling it declares', async () => {
    const roles = projectRolesOf({ [MACHINE]: { [MCP_SCOPE.APP_READ]: {} } });
    expect(credentialCeiling({ roles })).not.toBeNull();
    const guard = guardFor(IAM_PERMISSION.APP_WRITE);
    await expect(
      guard.canActivate(context({ userId: 'm1', email: 'a@x', roles })),
    ).rejects.toThrow(ForbiddenException);
  });
});
