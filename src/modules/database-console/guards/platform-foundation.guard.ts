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
 * Somewhere else is now a place: `GET /system/db/:key/connection-info`, which
 * hands a caller holding platform authority the coordinates and nothing more —
 * she opens the tunnel herself and reads the password out of the cluster. That
 * road takes nothing from this one. It names no application, so this guard is
 * never asked; it opens no connection, so the resolvers are never asked; and it
 * asks KubePortForwardService for no tunnel, so the transport is never asked.
 * All three depths are exactly as absolute as they were.
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
