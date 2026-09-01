import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PlatformAuthorityGuard } from './platform-authority.guard';
import { CONSOLE_TARGET_ABSENT } from '../constants/platform-foundations';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { MCP_SCOPE } from '../../mcp/constants/mcp-scopes';
import { SystemDbAuditService } from '../services/system-db-audit.service';

type Caller = {
  userId?: string;
  isAdmin?: boolean;
  scopes?: string[];
  roles?: Record<string, unknown>;
};

function contextFor(key: string, user: Caller | undefined): ExecutionContext {
  const req = { params: { key }, user };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
}

function guardWith(globalPermissions: string[], isAdmin = false) {
  const policy = {
    resolveAccess: jest.fn(async () => ({
      isAdmin,
      globalPermissions: new Set(globalPermissions),
      scopedGrants: [],
      isSandbox: false,
    })),
  };
  const audit = { emit: jest.fn() };
  const guard = new PlatformAuthorityGuard(
    policy as never,
    audit as unknown as SystemDbAuditService,
  );
  return { guard, audit, policy };
}

/**
 * The one road onto the platform's own database. Everything the console fence
 * refuses absolutely is behind this, so the questions it asks and the order it
 * asks them in are the whole of the protection.
 */
describe('who may ask where the platform database is', () => {
  it('lets a principal holding app:write at global scope through', async () => {
    const { guard } = guardWith([IAM_PERMISSION.APP_WRITE]);
    await expect(
      guard.canActivate(contextFor('platform-postgres', { userId: 'u1' })),
    ).resolves.toBe(true);
  });

  it('lets an administrator through', async () => {
    const { guard } = guardWith([], true);
    await expect(
      guard.canActivate(contextFor('platform-postgres', { userId: 'u1' })),
    ).resolves.toBe(true);
  });

  /**
   * The refusal that matters most: an owner of applications is not an owner of
   * the installation, and the words she gets back are the words she gets for
   * any id that is not hers.
   */
  it('answers absence to a tenant who owns applications and not the platform', async () => {
    const { guard } = guardWith([]);
    const activate = guard.canActivate(
      contextFor('platform-postgres', { userId: 'u2' }),
    );
    await expect(activate).rejects.toBeInstanceOf(NotFoundException);
    await expect(activate).rejects.toThrow(CONSOLE_TARGET_ABSENT);
  });

  it('answers absence to nobody at all', async () => {
    const { guard } = guardWith([IAM_PERMISSION.APP_WRITE]);
    await expect(
      guard.canActivate(contextFor('platform-postgres', undefined)),
    ).rejects.toThrow(CONSOLE_TARGET_ABSENT);
  });

  /**
   * A grant narrowed to one cluster says what somebody may do there. The
   * platform's own database is not there — a scoped grant contributes nothing
   * to `globalPermissions`, which is exactly why the rule reads that set.
   */
  it('refuses a permission that is held but not at global scope', async () => {
    const policy = {
      resolveAccess: jest.fn(async () => ({
        isAdmin: false,
        globalPermissions: new Set<string>(),
        scopedGrants: [
          { scope: 'cluster', permissions: [IAM_PERMISSION.APP_WRITE] },
        ],
        isSandbox: false,
      })),
    };
    const guard = new PlatformAuthorityGuard(
      policy as never,
      {
        emit: jest.fn(),
      } as unknown as SystemDbAuditService,
    );
    await expect(
      guard.canActivate(contextFor('platform-postgres', { userId: 'u3' })),
    ).rejects.toThrow(CONSOLE_TARGET_ABSENT);
  });

  /**
   * The ceiling is the one check an administrator does not outgrow, and it is
   * asked first: a scoped agent key is least-privilege whoever is behind it.
   */
  it('refuses a scoped key that never mentions this verb, administrator or not', async () => {
    const { guard } = guardWith([], true);
    await expect(
      guard.canActivate(
        contextFor('platform-postgres', {
          userId: 'u1',
          isAdmin: true,
          scopes: [MCP_SCOPE.APP_READ],
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('never asks the policy engine once the credential has already said no', async () => {
    const { guard, policy } = guardWith([IAM_PERMISSION.APP_WRITE], true);
    await expect(
      guard.canActivate(
        contextFor('platform-postgres', {
          userId: 'u1',
          scopes: [MCP_SCOPE.APP_READ],
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(policy.resolveAccess).not.toHaveBeenCalled();
  });
});

/**
 * Nobody is meant to walk this road often, which is precisely why a single
 * step on it has to be visible afterwards — the refusals included.
 */
describe('what the road records', () => {
  it('records the refusal of a caller without platform authority', async () => {
    const { guard, audit } = guardWith([]);
    await expect(
      guard.canActivate(contextFor('identity-provider', { userId: 'u2' })),
    ).rejects.toThrow(CONSOLE_TARGET_ABSENT);
    expect(audit.emit).toHaveBeenCalledWith({
      foundationKey: 'identity-provider',
      userId: 'u2',
      result: 'deny',
      reason: 'not_platform_authority',
    });
  });

  it('records the refusal of a scoped credential separately, since the repair differs', async () => {
    const { guard, audit } = guardWith([IAM_PERMISSION.APP_WRITE]);
    await expect(
      guard.canActivate(
        contextFor('platform-postgres', {
          userId: 'u1',
          scopes: [MCP_SCOPE.APP_READ],
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(audit.emit).toHaveBeenCalledWith({
      foundationKey: 'platform-postgres',
      userId: 'u1',
      result: 'deny',
      reason: 'credential_ceiling',
    });
  });
});

/**
 * The line that carries all of it, pinned the way the module already pins the
 * console fence.
 *
 * `platform-foundation.reach.spec.ts` counts the guard on every controller
 * under `applications/:id` — and its stated reason is that "the guard is one
 * line on a class, and a line is exactly the kind of thing a new controller is
 * written without". This controller mounts outside that prefix, deliberately
 * and for a good reason, and in doing so it stepped out of the only census in
 * the module that notices a deleted `@UseGuards` — on the one route that says
 * where the platform's own Postgres lives. Deleting the decoration left every
 * suite green.
 *
 * Read off the source rather than off the metadata for the same reason the
 * reach census is: importing the controller drags its whole tree in, and what
 * is being asked is what is *written* on the class.
 */
describe('every road outside the console prefix carries this guard', () => {
  const dir = path.join(__dirname, '..', 'controllers');
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('system-') && f.endsWith('.controller.ts'));

  it('finds the controllers it is meant to be pinning', () => {
    expect(files).toContain('system-db.controller.ts');
  });

  it.each(files)('%s names PlatformAuthorityGuard', (file) => {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const useGuards = /@UseGuards\(([^)]*)\)/.exec(src);
    expect(useGuards).not.toBeNull();
    const listed = (useGuards as RegExpExecArray)[1]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    expect(listed).toContain('PlatformAuthorityGuard');
  });

  /**
   * The other half of the same worry: a foundation route that quietly moved
   * back under `applications/:id` would be inside the console fence, which
   * refuses precisely what this exists to reach.
   */
  it.each(files)('%s stays off the console prefix', (file) => {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    expect(src).not.toMatch(/@Controller\(\s*'[^']*applications\/:id/);
  });
});
