import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import {
  isReadOnlyArea,
  isSandboxAllowed,
  SANDBOX_READ_ONLY_WRITE_CODE,
  SANDBOX_READ_ONLY_WRITE_MESSAGE,
} from '../constants/sandbox-fence';
import {
  SANDBOX_STAND_IN_WRITE_CODE,
  SANDBOX_STAND_IN_WRITE_MESSAGE,
  isStandInArea,
} from '../stand-in/sandbox-stand-in';

export const SANDBOX_FORBIDDEN_CODE = 'SANDBOX_ROUTE_FORBIDDEN';

/**
 * Set on the request when the caller turned out to be a guest, so the response
 * projection downstream does not repeat the access resolution the guard has
 * just paid for. Guards run before interceptors, so it is always there by the
 * time the projection reads it.
 */
export const SANDBOX_GUEST_REQUEST = Symbol('sandboxGuest');

export interface SandboxGuestRequest {
  [SANDBOX_GUEST_REQUEST]?: { userId: string };
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
  constructor(@Inject(POLICY_ENGINE) private readonly policy: PolicyEngine) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const req = context
      .switchToHttp()
      .getRequest<
        Request & { user?: AuthenticatedUser } & SandboxGuestRequest
      >();
    const user = req.user;
    if (!user || user.isAdmin) return true;

    const access = await this.policy.resolveAccess({
      userId: user.userId,
      email: user.email,
      role: user.role,
      isAdmin: false,
      scopes: user.scopes,
    });
    if (!access.isSandbox) return true;
    req[SANDBOX_GUEST_REQUEST] = { userId: user.userId };

    // Match on the matched route pattern, not the raw URL: an id that happens to
    // contain a slash or an encoded segment must never change the verdict.
    const pattern = (req.route as { path?: string } | undefined)?.path;
    const path = stripPrefix(pattern ?? req.path);

    if (isSandboxAllowed(req.method, path)) return true;

    // A write on a section the guest can see, filled with examples, is still
    // refused — but not with "this is disabled here", which contradicts the
    // section open in front of them. The door stays shut either way; only the
    // wording changes, because a refusal a person cannot make sense of reads as
    // a bug in the product.
    if (isStandInArea(path)) {
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
    if (isReadOnlyArea(path)) {
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
      message:
        'This is disabled in the Flui sandbox. See GET /sandbox/limits for what is available here and why.',
      route: `${req.method} ${path}`,
    });
  }
}

/** Routes are declared without the global API prefix. */
function stripPrefix(path: string): string {
  return path.replace(/^\/api\/v\d+/, '');
}
