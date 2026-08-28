import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AppOwnershipGuard } from './app-ownership.guard';
import {
  assertNotPlatformFoundation,
  CONSOLE_TARGET_ABSENT,
} from '../constants/platform-foundations';
import { MCP_SCOPE } from '../../mcp/constants/mcp-scopes';

function contextFor(
  appId: string | undefined,
  user: Caller | undefined,
): ExecutionContext {
  const req = { params: appId ? { id: appId } : {}, user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

type Caller = {
  userId?: string;
  isAdmin?: boolean;
  scopes?: string[];
  roles?: Record<string, unknown>;
};

type Row = {
  id?: string;
  slug?: string;
  userId: string | null;
  ownerKind?: string | null;
  ownerRef?: string | null;
};

function guardOver(
  apps: Record<string, Row>,
  globalPermissions: string[] = [],
) {
  const repo = {
    findById: jest.fn(async (id: string) => apps[id] ?? null),
  };
  const policy = {
    resolveAccess: jest.fn(async () => ({
      isAdmin: false,
      globalPermissions: new Set(globalPermissions),
      scopedGrants: [],
      isSandbox: false,
    })),
  };
  return new AppOwnershipGuard(repo as never, policy as never);
}

/**
 * The consoles are the sharpest surface in the product — arbitrary SQL against a
 * database, and the decrypted contents of a secrets store — and this guard is
 * the only gate on thirteen of them.
 */
describe('who may open an application console', () => {
  const owned = { userId: 'u1' };
  const unowned = { userId: null };

  it('lets the owner in', async () => {
    const guard = guardOver({ a: owned });
    await expect(
      guard.canActivate(contextFor('a', { userId: 'u1' })),
    ).resolves.toBe(true);
  });

  it('keeps another tenant out of an owned application', async () => {
    const guard = guardOver({ a: owned });
    await expect(
      guard.canActivate(contextFor('a', { userId: 'u2' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  /**
   * The one this file exists for.
   *
   * `zitadel`, the platform Postgres, Umami's databases and Penpot's Postgres
   * all carry no owner on a real installation. Read as "allowed to everybody",
   * the rule handed the SQL console of the identity provider to any
   * authenticated caller — and the sandbox opens `/applications/:id/**` to a
   * guest, so it reached the public door. Measured, not imagined: a guest
   * credential ran a query against another tenancy's database and got rows.
   */
  it('keeps an unowned application away from everyone who is not an administrator', async () => {
    const guard = guardOver({ zitadel: unowned });
    await expect(
      guard.canActivate(contextFor('zitadel', { userId: 'guest-1' })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('still lets an administrator reach an unowned application', async () => {
    const guard = guardOver({ zitadel: unowned });
    await expect(
      guard.canActivate(
        contextFor('zitadel', { userId: 'root', isAdmin: true }),
      ),
    ).resolves.toBe(true);
  });

  it('answers absence, not prohibition, so a stranger learns nothing', async () => {
    const guard = guardOver({ zitadel: unowned });
    await expect(
      guard.canActivate(contextFor('zitadel', { userId: 'guest-1' })),
    ).rejects.not.toBeInstanceOf(ForbiddenException);
  });

  it('says nothing about an id that names no application', async () => {
    const guard = guardOver({});
    await expect(
      guard.canActivate(contextFor('nope', { userId: 'u1' })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

/**
 * What the provenance columns changed. `userId = null` used to mean two things
 * at once — the platform put this here, and an install credential recorded no
 * owner — and one rule had to cover both. The bootstrap has declared the
 * difference all along; these are the cases that now read it.
 */
describe('a row the platform declares, and a row nobody registered', () => {
  const platform = {
    id: 'p1',
    slug: 'zitadel',
    userId: null,
    ownerKind: 'platform',
    ownerRef: 'flui-core',
  };
  const unregistered = { id: 'u9', slug: 'umami-db', userId: null };

  it('opens a platform row to platform-level authority', async () => {
    const guard = guardOver({ p1: platform }, ['app:write']);
    await expect(
      guard.canActivate(contextFor('p1', { userId: 'ops-1' })),
    ).resolves.toBe(true);
  });

  it('keeps a platform row shut to a grant that is not platform-level', async () => {
    const guard = guardOver({ p1: platform }, []);
    await expect(
      guard.canActivate(contextFor('p1', { userId: 'tenant-1' })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  /**
   * The registration defect. It looks identical to a platform row from outside
   * — both carry no owner — and that is exactly why it was indistinguishable
   * before. Platform-level authority does NOT open it: nothing declares it, so
   * there is nothing to be authoritative over.
   */
  it('does not let platform-level authority reach a row nobody registered', async () => {
    const guard = guardOver({ u9: unregistered }, ['app:write']);
    await expect(
      guard.canActivate(contextFor('u9', { userId: 'ops-1' })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('still answers absence rather than prohibition for both', async () => {
    const guard = guardOver({ p1: platform, u9: unregistered }, []);
    await expect(
      guard.canActivate(contextFor('p1', { userId: 'tenant-1' })),
    ).rejects.not.toBeInstanceOf(ForbiddenException);
    await expect(
      guard.canActivate(contextFor('u9', { userId: 'tenant-1' })),
    ).rejects.not.toBeInstanceOf(ForbiddenException);
  });

  it('leaves an owned row deciding by ownership, whatever the platform holds', async () => {
    const owned = { id: 'a', slug: 'mine', userId: 'u1' };
    const guard = guardOver({ a: owned }, ['app:write']);
    await expect(
      guard.canActivate(contextFor('a', { userId: 'u1' })),
    ).resolves.toBe(true);
  });
});

/**
 * A live probe against the running instance found this: the fence answered
 * `Application console not found` while an absent row answered
 * `Application <id> not found`. Two sentences, told apart by anyone reading the
 * body — and the second one repeated the id back, confirming the question was
 * answerable. The guard's own comment claimed the opposite.
 *
 * So the equality is pinned here rather than described. Changing either message
 * without changing the other turns this red, which is the only way a promise
 * about two separate throw sites stays true.
 */
describe('a refusal tells a prober nothing about which refusal it is', () => {
  async function messageFrom(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn();
    } catch (error) {
      return (error as NotFoundException).message;
    }
    throw new Error('expected a refusal');
  }

  it('says the same words for an absent row, a foundation and a row that is neither', async () => {
    const guard = guardOver({
      platform: { userId: null, ownerKind: 'platform' },
      undeclared: { id: 'undeclared', slug: 'umami-db', userId: null },
    });

    const absent = await messageFrom(() =>
      guard.canActivate(contextFor('nothing-here', { userId: 'u1' })),
    );
    const platform = await messageFrom(() =>
      guard.canActivate(contextFor('platform', { userId: 'u1' })),
    );
    const undeclared = await messageFrom(() =>
      guard.canActivate(contextFor('undeclared', { userId: 'u1' })),
    );
    const foundation = await messageFrom(async () =>
      assertNotPlatformFoundation({
        slug: 'zitadel',
        k8sNamespace: 'flui-system',
      }),
    );

    expect(new Set([absent, platform, undeclared, foundation]).size).toBe(1);
    expect(absent).toBe(CONSOLE_TARGET_ABSENT);
  });

  it('never repeats the id it was asked about', async () => {
    const guard = guardOver({});
    const said = await messageFrom(() =>
      guard.canActivate(contextFor('9f1c-secret-looking-id', { userId: 'u1' })),
    );
    expect(said).not.toContain('9f1c-secret-looking-id');
  });
});

/**
 * The consoles were the one part of the application surface the credential
 * ceiling never reached. Four of the fourteen controllers carried
 * `@RequirePermission(app:write)` and got it through `PermissionsGuard`; the
 * other ten — arbitrary SQL, the object store, every backup and restore route —
 * carried only this guard, which had never heard of scopes. A key minted for an
 * agent, held by the application's own owner, passed ownership because it *is*
 * the owner.
 */
describe('the key in the hand, not only the person behind it', () => {
  const mine = { userId: 'u1' };

  it("refuses a scoped agent key on the owner's own console", async () => {
    const guard = guardOver({ a: mine });
    await expect(
      guard.canActivate(
        contextFor('a', { userId: 'u1', scopes: [MCP_SCOPE.APP_READ] }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses it to an administrator too — a ceiling is not outgrown', async () => {
    const guard = guardOver({ a: mine });
    await expect(
      guard.canActivate(
        contextFor('a', {
          userId: 'admin',
          isAdmin: true,
          scopes: [MCP_SCOPE.APP_READ],
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a key through whose scopes do carry the verb', async () => {
    const guard = guardOver({ a: mine });
    await expect(
      guard.canActivate(
        contextFor('a', { userId: 'u1', scopes: [MCP_SCOPE.APP_WRITE] }),
      ),
    ).resolves.toBe(true);
  });

  /**
   * `scopes: null` on the row means "nothing declared" and is what every
   * interactive session, the CLI key and the service identities carry. Reading
   * that as an empty ceiling would shut the product.
   */
  it('changes nothing for a credential that declares no ceiling', async () => {
    const guard = guardOver({ a: mine });
    await expect(
      guard.canActivate(contextFor('a', { userId: 'u1' })),
    ).resolves.toBe(true);
  });

  /**
   * Asked before the row is loaded, so the refusal names the credential's own
   * scopes instead of telling a prober whether the id resolves to anything.
   */
  it('answers the ceiling before it learns whether the application exists', async () => {
    const guard = guardOver({});
    await expect(
      guard.canActivate(
        contextFor('nothing-here', {
          userId: 'u1',
          scopes: [MCP_SCOPE.APP_READ],
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
