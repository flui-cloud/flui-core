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

    const user = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>().user;
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
