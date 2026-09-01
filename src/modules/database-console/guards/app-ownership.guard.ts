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
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import {
  isPlatformOwned,
  isUnattributed,
} from '../../applications/constants/app-provenance';
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

/**
 * Authorizes console access. The global JwtAuthGuard only authenticates: without
 * this gate any logged-in user could open another user's app console — and read
 * its decrypted secrets — by guessing the appId (classic IDOR).
 *
 * It decides on three different facts, and it used to have only one.
 *
 * **An owned row** belongs to a person: the caller passes only if
 * {@link ApplicationAccessService} says so, the same policy engine every other
 * app-scoped route asks. Owning an application is not by itself permission to
 * open its console — it is what an `owner` grant selects on — so an owner
 * holding no grant that reaches the application is refused here, exactly as
 * everywhere else. This guard used to decide it by raw
 * `app.userId === user.userId` equality, which meant a grant revoked or
 * narrowed away from your own application applied everywhere in the product
 * except here.
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
 * Every refusal that is not "it belongs to somebody else" says
 * {@link CONSOLE_TARGET_ABSENT}, the same words the foundation fence uses. That
 * is what makes the claim on {@link PlatformFoundationGuard} true rather than
 * intended: a caller probing ids cannot separate a foundation from a row that
 * does not exist from a row that exists and is not theirs to know about. The
 * sentence also stopped echoing the id back, which was the other half of the
 * leak — a refusal that repeats what you asked for confirms you asked something
 * answerable.
 *
 * **The key in the caller's hand** is asked about first, before the row is even
 * loaded. Four of the fourteen consoles carried `@RequirePermission(app:write)`
 * and so passed through `PermissionsGuard`, which applies the credential
 * ceiling; the other ten did not, and among them are arbitrary SQL, the object
 * store and every backup route. An `mcp:*` scoped key held by the application's
 * own owner walked straight past ownership — it *is* the owner — into a SQL
 * prompt its scopes never mentioned. The ceiling is the one check in the
 * product that an administrator does not outgrow, and it was missing from the
 * sharpest surface it exists for.
 *
 * `app:write` even on a GET, for the reason already given above: this guard is
 * verb-blind, and `connection-info` hands back credentials.
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
    private readonly appAccess: ApplicationAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      params?: Record<string, string>;
      user?: AuthenticatedUser;
    }>();

    const appId = req.params?.id;
    if (!appId) return true;

    const user = req.user;

    // Asked before the row is loaded, and before isAdmin, for the same two
    // reasons AppAccessGuard asks it there: whether the credential carries this
    // verb at all does not depend on which application was named, and a scoped
    // key deserves a refusal that names its own scopes rather than one that
    // leaks whether the id exists.
    const ceiling = credentialCeiling(user);
    if (ceiling && !ceiling.has(IAM_PERMISSION.APP_WRITE)) {
      throw new ForbiddenException(
        ceilingRefusal(IAM_PERMISSION.APP_WRITE, user),
      );
    }

    const app = await this.applicationsRepo.findById(appId);
    if (!app) {
      throw new NotFoundException(CONSOLE_TARGET_ABSENT);
    }

    if (user?.isAdmin) return true;

    if (isPlatformOwned(app)) {
      if (await holdsPlatformAuthority(this.policy, user)) return true;
      throw new NotFoundException(CONSOLE_TARGET_ABSENT);
    }

    if (isUnattributed(app)) {
      this.logger.warn(
        `Application ${app.slug} (${app.id}) has no owner and no declared provenance: ` +
          'nobody but an administrator can reach its console until the row records one.',
      );
      throw new NotFoundException(CONSOLE_TARGET_ABSENT);
    }

    if (!app.userId) {
      // Declared `user` provenance without a recorded owner — the same gap,
      // said out loud by the manifest rather than by silence.
      throw new NotFoundException(CONSOLE_TARGET_ABSENT);
    }

    if (
      !user ||
      !(await this.appAccess.can(user, IAM_PERMISSION.APP_WRITE, app))
    ) {
      throw new ForbiddenException(
        "You don't have access to this application's console.",
      );
    }
    return true;
  }
}
