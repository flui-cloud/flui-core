import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import {
  isPlatformOwned,
  isUnattributed,
} from '../../applications/constants/app-provenance';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import { principalFromUser } from '../../iam/interfaces/iam.types';

/**
 * Authorizes console access. The global JwtAuthGuard only authenticates: without
 * this gate any logged-in user could open another user's app console — and read
 * its decrypted secrets — by guessing the appId (classic IDOR).
 *
 * It decides on three different facts, and it used to have only one.
 *
 * **An owned row** belongs to a person: the owner passes, another tenant is
 * refused by name, and that is unchanged.
 *
 * **A row the platform declares** — `ownerKind = platform`, read from
 * `flui.cloud/owner-kind` on the resource the bootstrap created — belongs to
 * nobody, and answering "unowned, so administrators only" was a safety net over
 * a fact nobody had read. Provenance is the fact, so the rule follows it: a
 * platform row opens to a principal holding platform-level authority, which IAM
 * already has a name for — a permission granted at GLOBAL scope, the same level
 * a management section demands. Not a new concept and not a new permission.
 *
 * The verb asked for is `app:write` even on a GET, deliberately. This guard is
 * verb-blind — one decoration covers thirteen controllers, arbitrary SQL and
 * decrypted secrets alike — so the level it asks for has to be the level the
 * sharpest route behind it deserves. When each route names its own action, this
 * becomes that action at global scope and the coarseness goes away on its own.
 *
 * **A row with no owner and no declaration** is neither: it is an application
 * an install credential created without recording who for. Umami's databases
 * and Penpot's Postgres are in that state on the live instance. It is refused
 * like an absence — naming it would confirm to a stranger that this id runs
 * something here — and it is logged, because a defect that is only refused is a
 * defect nobody ever fixes.
 *
 * Applied at the controller layer (not the resolvers) so the full authenticated
 * principal — including isAdmin — is in scope without threading it through every
 * resolve input. Expects the appId on the `:id` route param.
 */
@Injectable()
export class AppOwnershipGuard implements CanActivate {
  private readonly logger = new Logger(AppOwnershipGuard.name);

  constructor(
    private readonly applicationsRepo: ApplicationsRepository,
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      params?: Record<string, string>;
      user?: AuthenticatedUser;
    }>();

    const appId = req.params?.id;
    if (!appId) return true;

    const app = await this.applicationsRepo.findById(appId);
    if (!app) {
      throw new NotFoundException(`Application ${appId} not found`);
    }

    const user = req.user;
    if (user?.isAdmin) return true;

    if (isPlatformOwned(app)) {
      if (await this.holdsPlatformAuthority(user)) return true;
      throw new NotFoundException(`Application ${appId} not found`);
    }

    if (isUnattributed(app)) {
      this.logger.warn(
        `Application ${app.slug} (${app.id}) has no owner and no declared provenance: ` +
          'nobody but an administrator can reach its console until the row records one.',
      );
      throw new NotFoundException(`Application ${appId} not found`);
    }

    if (!app.userId) {
      // Declared `user` provenance without a recorded owner — the same gap,
      // said out loud by the manifest rather than by silence.
      throw new NotFoundException(`Application ${appId} not found`);
    }

    if (app.userId !== user?.userId) {
      throw new ForbiddenException(
        "You don't have access to this application's console. It belongs to another user.",
      );
    }
    return true;
  }

  /**
   * Held at GLOBAL scope, not merely held. A grant narrowed by a selector or to
   * one cluster says what somebody may do *there*; the platform's own components
   * are not there, they are underneath. `globalPermissions` is exactly the set
   * IAM already separates for that reason.
   */
  private async holdsPlatformAuthority(
    user: AuthenticatedUser | undefined,
  ): Promise<boolean> {
    if (!user) return false;
    const access = await this.policy.resolveAccess(principalFromUser(user));
    return (
      access.isAdmin || access.globalPermissions.has(IAM_PERMISSION.APP_WRITE)
    );
  }
}
