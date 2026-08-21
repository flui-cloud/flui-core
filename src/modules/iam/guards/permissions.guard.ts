import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRED_PERMISSION_KEY } from '../decorators/require-permission.decorator';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../interfaces/policy-engine.interface';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IamPrincipal } from '../interfaces/iam.types';
import { SANDBOX_GUEST_REQUEST } from '../../sandbox/guards/sandbox-fence.guard';
import { isSandboxStandInRequest } from '../../sandbox/stand-in/sandbox-stand-in';

/**
 * Global authorization gate. Runs after JwtAuthGuard. Default-deny for routes
 * carrying @RequirePermission; pass-through otherwise (so un-migrated routes keep
 * their current guards during rollout). Only hits the DB when a permission is required.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string>(
      REQUIRED_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const req = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
      method?: string;
      route?: { path?: string };
      path?: string;
      [SANDBOX_GUEST_REQUEST]?: unknown;
    }>();
    // Answered from the example world before the handler is reached — there is
    // no privileged read behind this to protect. Refusing here would close a
    // section the fence has deliberately opened, which is how a guest ends up
    // with a menu entry that leads to an error.
    if (req[SANDBOX_GUEST_REQUEST] && isSandboxStandInRequest(req)) return true;

    const user = req.user;
    if (!user) throw new ForbiddenException('Unauthenticated');

    const principal: IamPrincipal = {
      userId: user.userId,
      email: user.email,
      role: user.role,
      isAdmin: !!user.isAdmin,
      scopes: user.scopes,
    };
    if (!(await this.policy.check(principal, required))) {
      throw new ForbiddenException(`Missing required permission: ${required}`);
    }
    return true;
  }
}
