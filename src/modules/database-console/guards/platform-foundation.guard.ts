import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';
import { assertNotPlatformFoundation } from '../constants/platform-foundations';

/**
 * Closes the portal's consoles over the platform's own foundations — see
 * PLATFORM_FOUNDATIONS for which, and why each one is there.
 *
 * It runs ahead of AppOwnershipGuard and answers the same way to everybody,
 * administrators included: this is not a permission that a strong enough
 * principal outgrows. The decision is that access to these two exists somewhere
 * else, not through the portal.
 *
 * A missing row is left to the ownership guard, so the two cannot be told apart
 * from outside: both answer that there is nothing here.
 */
@Injectable()
export class PlatformFoundationGuard implements CanActivate {
  constructor(private readonly applicationsRepo: ApplicationsRepository) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<{ params?: Record<string, string> }>();

    const appId = req.params?.id;
    if (appId) {
      assertNotPlatformFoundation(await this.applicationsRepo.findById(appId));
    }
    return true;
  }
}
