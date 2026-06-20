import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';

/**
 * Authorizes console access by application ownership. The global JwtAuthGuard only
 * authenticates: without this gate any logged-in user could open another user's app
 * console — and read its decrypted secrets — by guessing the appId (classic IDOR).
 *
 * Allows the owner, any admin / service-account (isAdmin), and apps with no owner
 * (system apps and M2M/API-key installs carry userId = null). This is ownership-only;
 * fine-grained roles (per-app grants, teams, read-only members) are deferred to the
 * full user-management feature tracked in the shared backlog.
 *
 * Applied at the controller layer (not the resolvers) so the full authenticated
 * principal — including isAdmin — is in scope without threading it through every
 * resolve input. Expects the appId on the `:id` route param.
 */
@Injectable()
export class AppOwnershipGuard implements CanActivate {
  constructor(private readonly applicationsRepo: ApplicationsRepository) {}

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
    if (app.userId && app.userId !== user?.userId) {
      throw new ForbiddenException(
        "You don't have access to this application's console. It belongs to another user.",
      );
    }
    return true;
  }
}
