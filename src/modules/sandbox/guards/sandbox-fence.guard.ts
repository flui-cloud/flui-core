import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { SANDBOX_ACTIVITY, SandboxActivity } from '../gate/sandbox-activity';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { principalFromUser } from '../../iam/interfaces/iam.types';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import {
  isReadOnlyArea,
  isSandboxAllowed,
  sandboxLevelOf,
  SANDBOX_FORBIDDEN_MESSAGE,
  SANDBOX_READ_ONLY_WRITE_CODE,
  SANDBOX_READ_ONLY_WRITE_MESSAGE,
} from '../constants/sandbox-fence';
import type { SandboxLevel } from '../constants/sandbox-fence-core';
import {
  SANDBOX_STAND_IN_WRITE_CODE,
  SANDBOX_STAND_IN_WRITE_MESSAGE,
  isStandInArea,
} from '../stand-in/sandbox-stand-in';
import { ModuleRef } from '@nestjs/core';
import { SandboxScopeService } from '../services/sandbox-scope.service';
import { loadSandboxConfig } from '../sandbox.config';

export const SANDBOX_FORBIDDEN_CODE = 'SANDBOX_ROUTE_FORBIDDEN';

/**
 * Set on the request when the caller turned out to be a guest, so the response
 * projection downstream does not repeat the access resolution the guard has
 * just paid for. Guards run before interceptors, so it is always there by the
 * time the projection reads it.
 */
export const SANDBOX_GUEST_REQUEST = Symbol('sandboxGuest');

/**
 * Set when this guard has admitted a guest's request by name.
 *
 * The fence is the authority on what a guest may reach, and it runs before the
 * IAM guards. Recording its verdict lets `PermissionsGuard` defer to a decision
 * already taken instead of re-deriving it — which matters for the routes the
 * fence opens read-only on the strength of `section:view`, where the guest holds
 * no governing permission and never will.
 */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const SANDBOX_FENCE_ADMITTED = Symbol('sandboxFenceAdmitted');

export interface SandboxGuestRequest {
  [SANDBOX_GUEST_REQUEST]?: { userId: string };
  [SANDBOX_FENCE_ADMITTED]?: SandboxLevel;
}

/**
 * The outer half of the sandbox fence, global and default-deny: a guest may call
 * only what SANDBOX_ALLOWLIST names. It runs after authentication and before the
 * per-resource guards, so a guest is stopped at the door of an area rather than
 * at the ownership check inside it.
 *
 * Non-guests are untouched — the guard costs them one `isAdmin` read and, for
 * ordinary users, the access resolution the request would do anyway.
 */
@Injectable()
export class SandboxFenceGuard implements CanActivate {
  constructor(
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
    @Optional()
    @Inject(SANDBOX_ACTIVITY)
    private readonly activity?: SandboxActivity,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  /**
   * A route that names a cluster answers about that cluster, whatever the rule
   * that admitted it says about the area: a guest names its own cluster or
   * nothing. Pinned here, before any handler runs, so no reader, refresh or
   * capability check has to remember it.
   */
  private async ownClusterOf(userId: string): Promise<string | null> {
    let scope: SandboxScopeService | undefined;
    try {
      scope = this.moduleRef?.get(SandboxScopeService, { strict: false });
    } catch {
      scope = undefined;
    }
    if (!scope) return loadSandboxConfig().clusterId;
    return (await scope.resolve(userId, ['clusterId'])).clusterId;
  }

  private async assertOwnCluster(
    userId: string,
    pattern: string,
    params: Record<string, string | undefined>,
  ): Promise<void> {
    const named =
      params.clusterId ??
      (/\/clusters\/:id(\/|$)/.test(pattern) ? params.id : undefined);
    if (!named) return;
    const own = await this.ownClusterOf(userId);
    if (!own || named !== own) {
      throw new ForbiddenException({
        statusCode: 403,
        code: SANDBOX_FORBIDDEN_CODE,
        message: SANDBOX_FORBIDDEN_MESSAGE,
        route: pattern,
      });
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const req = context
      .switchToHttp()
      .getRequest<
        Request & { user?: AuthenticatedUser } & SandboxGuestRequest
      >();
    const user = req.user;
    if (!user || user.isAdmin) return true;

    // `isAdmin: false` stays explicit: the line above already lets an
    // administrator through, and the fence must not start depending on that.
    const access = await this.policy.resolveAccess({
      ...principalFromUser(user),
      isAdmin: false,
    });
    if (!access.isSandbox) return true;
    req[SANDBOX_GUEST_REQUEST] = { userId: user.userId };

    // Match on the matched route pattern, not the raw URL: an id that happens to
    // contain a slash or an encoded segment must never change the verdict.
    const pattern = (req.route as { path?: string } | undefined)?.path;
    const path = stripPrefix(pattern ?? req.path);

    const route = pattern !== undefined;
    if (isSandboxAllowed(req.method, path, route)) {
      if (route) {
        await this.assertOwnCluster(
          user.userId,
          path,
          (req.params ?? {}) as Record<string, string | undefined>,
        );
      }
      req[SANDBOX_FENCE_ADMITTED] = sandboxLevelOf(req.method, path, route);
      // A read is not activity: an open tab polls, a person acts.
      if (!READS.has(req.method)) {
        void this.activity?.touch(user.userId).catch(() => undefined);
      }
      return true;
    }

    // A write on a section the guest can see, filled with examples, is still
    // refused — but not with "this is disabled here", which contradicts the
    // section open in front of them. The door stays shut either way; only the
    // wording changes, because a refusal a person cannot make sense of reads as
    // a bug in the product.
    if (isStandInArea(path, route)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: SANDBOX_STAND_IN_WRITE_CODE,
        message: SANDBOX_STAND_IN_WRITE_MESSAGE,
        route: `${req.method} ${path}`,
      });
    }

    // Same reasoning for a section shown read-only with its real content: the
    // guest is looking at it, so "this is disabled in the sandbox" reads as a
    // fault rather than as the limit it is.
    if (isReadOnlyArea(path, route)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: SANDBOX_READ_ONLY_WRITE_CODE,
        message: SANDBOX_READ_ONLY_WRITE_MESSAGE,
        route: `${req.method} ${path}`,
      });
    }

    throw new ForbiddenException({
      statusCode: 403,
      code: SANDBOX_FORBIDDEN_CODE,
      message: SANDBOX_FORBIDDEN_MESSAGE,
      route: `${req.method} ${path}`,
    });
  }
}

/** Routes are declared without the global API prefix. */
function stripPrefix(path: string): string {
  return path.replace(/^\/api\/v\d+/, '');
}
