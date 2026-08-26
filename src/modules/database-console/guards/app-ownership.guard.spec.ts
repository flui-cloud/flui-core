import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AppOwnershipGuard } from './app-ownership.guard';

function contextFor(
  appId: string | undefined,
  user: { userId?: string; isAdmin?: boolean } | undefined,
): ExecutionContext {
  const req = { params: appId ? { id: appId } : {}, user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

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
