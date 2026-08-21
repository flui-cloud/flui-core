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
import { SANDBOX_GUEST_REQUEST } from '../../sandbox/guards/sandbox-fence.guard';
import { isSandboxStandInRequest } from '../../sandbox/stand-in/sandbox-stand-in';
import { isSafeVerb } from '../constants/iam-sections';
import { IS_PUBLIC_KEY } from '../../auth/decorators/public.decorator';

export const SECTION_READ_ONLY_CODE = 'SECTION_READ_ONLY';

// Global section gate: default-deny on @RequireSection routes, pass-through
// otherwise. Hits the DB only when a section is required. Admin passes.
//
// A section may also be entered at `read-only`, and that is enforced here
// rather than in the interface: the level opens the door, this refuses every
// verb that would change something behind it. Disabling the button in the
// browser stops a person; it does not stop a script holding the same
// credential, and the two must be told the same thing.
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

    // A handler marked @Public() is open by definition, and the section it
    // requires is almost always inherited from its controller rather than meant
    // for it. Without this, JwtAuthGuard lets the request through with no user
    // and this guard then refuses it as unauthenticated — which is how the
    // provider logo endpoint, declared public, answered 403 to everybody.
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
      method?: string;
      route?: { path?: string };
      path?: string;
      [SANDBOX_GUEST_REQUEST]?: unknown;
    }>();
    // Answered from the example world before the handler is reached; there is no
    // section behind it to gate.
    if (req[SANDBOX_GUEST_REQUEST] && isSandboxStandInRequest(req)) return true;

    const user = req.user;
    if (!user) throw new ForbiddenException('Unauthenticated');
    if (user.isAdmin) return true;

    const principal: IamPrincipal = {
      userId: user.userId,
      email: user.email,
      role: user.role,
      isAdmin: false,
      scopes: user.scopes,
    };
    const sections = await this.policy.resolveSectionAccess(principal);
    const granted = sections.find((s) => s.key === required);
    if (!granted) {
      throw new ForbiddenException(`Section not available: ${required}`);
    }
    if (granted.level === 'read-only' && !isSafeVerb(req.method)) {
      throw new ForbiddenException({
        statusCode: 403,
        code: SECTION_READ_ONLY_CODE,
        message: `You can look at this section but not change it: ${required}`,
      });
    }
    return true;
  }
}
