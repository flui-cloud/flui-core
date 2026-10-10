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
import { IamPrincipal, principalFromUser } from '../interfaces/iam.types';
import {
  SANDBOX_FENCE_ADMITTED,
  SANDBOX_GUEST_REQUEST,
} from '../../sandbox/guards/sandbox-fence.guard';
import { isSafeVerb } from '../constants/iam-sections';
import { isSandboxStandInRequest } from '../../sandbox/stand-in/sandbox-stand-in';
import {
  ceilingRefusal,
  credentialCeiling,
} from '../../auth/utils/credential-ceiling.util';
import { noteAuditPermission, noteDataAccess } from '../../audit/audit-request';
import { DATA_DOOR_KEY } from '../decorators/data-door.decorator';
import { IAM_PERMISSION } from '../constants/iam-permissions';

export { CREDENTIAL_CEILING_CODE } from '../../auth/utils/credential-ceiling.util';

/**
 * Global authorization gate. Runs after JwtAuthGuard. Default-deny for routes
 * carrying @RequirePermission or @DataDoor (which adds `data:access` to what
 * the route asks); pass-through otherwise (so un-migrated routes keep
 * their current guards during rollout). Only hits the DB when a permission is required.
 *
 * Two questions are asked here, and they are not the same question.
 *
 * The IAM check asks what the *person* may do. The ceiling asks what the
 * *credential* may do — an `mcp:*` scoped key is least-privilege even when the
 * person behind it is an administrator, and until now that was true only of the
 * MCP toolbox. It is a necessary condition on top of IAM, never a grant: it can
 * only refuse. A credential declaring no `mcp:*` scope (every interactive
 * session, the CLI key, the service identities) sees no change at all.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const declared = this.reflector.getAllAndOverride<string>(
      REQUIRED_PERMISSION_KEY,
      targets,
    );
    const door = !!this.reflector.getAllAndOverride<boolean>(
      DATA_DOOR_KEY,
      targets,
    );
    if (!declared && !door) return true;
    const required = [
      ...(declared ? [declared] : []),
      ...(door ? [IAM_PERMISSION.DATA_ACCESS] : []),
    ];

    const req = context.switchToHttp().getRequest<{
      user?: AuthenticatedUser;
      method?: string;
      route?: { path?: string };
      path?: string;
      [SANDBOX_GUEST_REQUEST]?: unknown;
      [SANDBOX_FENCE_ADMITTED]?: string;
    }>();
    if (declared) noteAuditPermission(req, declared);
    if (door) noteDataAccess(req);
    // Answered from the example world before the handler is reached — there is
    // no privileged read behind this to protect. Refusing here would close a
    // section the fence has deliberately opened, which is how a guest ends up
    // with a menu entry that leads to an error.
    if (req[SANDBOX_GUEST_REQUEST] && isSandboxStandInRequest(req)) return true;

    // A guest reading something the fence opened to them by name.
    //
    // The fence runs before this guard and is the authority on what a guest may
    // reach; several of the routes it shows read-only — the cluster's own
    // metrics, for one — are governed by a permission no guest holds, because
    // `section:view` is a level and not a subject. Without this, adding the
    // permission decorator those routes need in order to be closed to everybody
    // else would close them to the demonstration as well. Safe verbs only: a
    // write behind a shown section is still the section guard's to refuse.
    // Only where the guest is a spectator — a section shown read-only, or one
    // filled with examples. On the guest's own things the permissions still
    // decide, so a route admitted by a broad rule opens nothing by itself.
    if (
      req[SANDBOX_GUEST_REQUEST] &&
      (req[SANDBOX_FENCE_ADMITTED] === 'read-only' ||
        req[SANDBOX_FENCE_ADMITTED] === 'stand-in') &&
      isSafeVerb(req.method)
    ) {
      return true;
    }

    const user = req.user;
    if (!user) throw new ForbiddenException('Unauthenticated');

    // Asked before the IAM check: the credential question and the resource
    // question have different answers and different repairs.
    const ceiling = credentialCeiling(user);
    const beyondCeiling = required.find((p) => ceiling && !ceiling.has(p));
    if (beyondCeiling) {
      noteAuditPermission(req, beyondCeiling);
      throw new ForbiddenException(ceilingRefusal(beyondCeiling, user));
    }

    const principal: IamPrincipal = principalFromUser(user);
    for (const permission of required) {
      if (!(await this.policy.check(principal, permission))) {
        noteAuditPermission(req, permission);
        throw new ForbiddenException(
          `Missing required permission: ${permission}`,
        );
      }
    }
    return true;
  }
}
