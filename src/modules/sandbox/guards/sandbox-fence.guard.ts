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
import { isSandboxAllowed } from '../constants/sandbox-fence';

export const SANDBOX_FORBIDDEN_CODE = 'SANDBOX_ROUTE_FORBIDDEN';

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
      .getRequest<Request & { user?: AuthenticatedUser }>();
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

    // Match on the matched route pattern, not the raw URL: an id that happens to
    // contain a slash or an encoded segment must never change the verdict.
    const pattern = (req.route as { path?: string } | undefined)?.path;
    const path = stripPrefix(pattern ?? req.path);

    if (isSandboxAllowed(req.method, path)) return true;

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
