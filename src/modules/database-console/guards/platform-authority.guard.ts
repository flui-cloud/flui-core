import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { CONSOLE_TARGET_ABSENT } from '../constants/platform-foundations';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import {
  ceilingRefusal,
  credentialCeiling,
} from '../../auth/utils/credential-ceiling.util';
import { holdsPlatformAuthority } from './platform-authority.util';
import { SystemDbAuditService } from '../services/system-db-audit.service';

/**
 * The gate on the road the portal does not have — see {@link FOUNDATION_REACH}
 * for what is behind it and {@link PLATFORM_FOUNDATIONS} for why the portal
 * still has nothing.
 *
 * It asks the same two questions {@link AppOwnershipGuard} asks about a row the
 * platform declares, and it asks them in the same order, because the ordering
 * is the security property rather than a style:
 *
 *  1. **the key in the caller's hand**, before anything is loaded and before
 *     `isAdmin`. An `mcp:*` scoped key is least-privilege even when the person
 *     holding it is an administrator, and this is a strictly sharper surface
 *     than the tenant console the ceiling was added to. A scoped key gets a
 *     refusal that names its own scopes, which is the honest answer to "your
 *     credential does not carry this" and leaks nothing about the route.
 *  2. **platform authority**, held at GLOBAL scope. A grant narrowed to one
 *     cluster or one selector says what somebody may do there; the platform's
 *     own database is not there.
 *
 * Everyone else is told {@link CONSOLE_TARGET_ABSENT} — the same words a
 * console uses for a foundation, for an absent row and for somebody else's row.
 * A tenant probing this route learns only that it is not a route for her, which
 * is the same thing she learns about every id she does not own.
 *
 * There is no ownership question here on purpose: no row is named, so there is
 * nothing to own. The foundations belong to the installation, and holding the
 * installation is the whole of the qualification.
 */
@Injectable()
export class PlatformAuthorityGuard implements CanActivate {
  constructor(
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
    private readonly audit: SystemDbAuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      params?: Record<string, string>;
      user?: AuthenticatedUser;
    }>();

    const user = req.user;
    const asked = {
      foundationKey: req.params?.key,
      userId: user?.userId,
    };

    const ceiling = credentialCeiling(user);
    if (ceiling && !ceiling.has(IAM_PERMISSION.APP_WRITE)) {
      this.audit.emit({
        ...asked,
        result: 'deny',
        reason: 'credential_ceiling',
      });
      throw new ForbiddenException(
        ceilingRefusal(IAM_PERMISSION.APP_WRITE, user),
      );
    }

    if (await holdsPlatformAuthority(this.policy, user)) return true;

    this.audit.emit({
      ...asked,
      result: 'deny',
      reason: 'not_platform_authority',
    });
    throw new NotFoundException(CONSOLE_TARGET_ABSENT);
  }
}
