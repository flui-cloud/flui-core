import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { REQUIRED_SECTION_KEY } from '../decorators/require-section.decorator';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../interfaces/policy-engine.interface';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { IamPrincipal } from '../interfaces/iam.types';

// Global section gate: default-deny on @RequireSection routes, pass-through
// otherwise. Hits the DB only when a section is required. Admin passes.
@Injectable()
export class SectionAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string>(
      REQUIRED_SECTION_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required) return true;

    const user = context
      .switchToHttp()
      .getRequest<{ user?: AuthenticatedUser }>().user;
    if (!user) throw new ForbiddenException('Unauthenticated');
    if (user.isAdmin) return true;

    const principal: IamPrincipal = {
      userId: user.userId,
      email: user.email,
      role: user.role,
      isAdmin: false,
      scopes: user.scopes,
    };
    const sections = await this.policy.resolveSections(principal);
    if (!sections.includes(required)) {
      throw new ForbiddenException(`Section not available: ${required}`);
    }
    return true;
  }
}
