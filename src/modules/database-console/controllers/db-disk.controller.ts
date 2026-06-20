import { Controller, Get, Param, Request, UseGuards } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppOwnershipGuard } from '../guards/app-ownership.guard';
import { DbDiskInfo, DbDiskService } from '../services/db-disk.service';

/**
 * Disk usage + near-full alert for a database app. Interim `df`-based reading (no storage-layer
 * change) — reports the fullness of the filesystem hosting the volume, which is the boundary at
 * which the DB runs out of space. Native per-volume metrics are tracked in the shared backlog.
 */
@UseGuards(AppOwnershipGuard)
@Controller('applications/:id/db-disk')
export class DbDiskController {
  constructor(private readonly disk: DbDiskService) {}

  @Get()
  usage(
    @Param('id') id: string,
    @Request() req: { user: AuthenticatedUser },
  ): Promise<DbDiskInfo> {
    return this.disk.usage({ dbInstallId: id, fluiUserId: req.user.userId });
  }
}
