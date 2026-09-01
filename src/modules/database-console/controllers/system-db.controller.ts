import { Controller, Get, Param, Request, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { PlatformAuthorityGuard } from '../guards/platform-authority.guard';
import { SystemDbAccessService } from '../services/system-db-access.service';
import { DbConnectionInfo } from '../interfaces/db-connection';

/**
 * The road onto the platform's own database, and it is not a console.
 *
 * It is mounted here rather than under `applications/:id` on purpose, and the
 * purpose is not tidiness: every controller under that prefix carries
 * {@link PlatformFoundationGuard}, which refuses precisely the two things this
 * exists to reach. A foundation route there would either be refused by the
 * fence or would have to open a hole in it, and the second is not on offer.
 * Here there is no `:id`, no row, no console and nothing for the fence to be
 * asked about — the portal's absolute refusal is untouched and still absolute.
 *
 * What comes back is coordinates. The caller opens the tunnel herself over SSH
 * and an in-cluster port-forward and reads the password out of the Secret with
 * the cluster access she already had, so no password ever crosses the API and
 * Flui never speaks SQL to its own database on somebody's behalf.
 */
@UseGuards(PlatformAuthorityGuard)
@Controller('system/db')
export class SystemDbController {
  constructor(private readonly access: SystemDbAccessService) {}

  @Get(':key/connection-info')
  async connectionInfo(
    @Param('key') key: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<DbConnectionInfo> {
    return this.access.connectionInfo(key, req.user?.userId);
  }
}
