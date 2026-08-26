import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppOwnershipGuard } from '../guards/app-ownership.guard';
import { PlatformFoundationGuard } from '../guards/platform-foundation.guard';
import {
  DbPitrService,
  DbPitrStatus,
} from '../../backups/services/db-pitr.service';
import { DbPitrRestoreDto } from '../../backups/dto/db-pitr-restore.dto';

/**
 * DB-tab continuous-backup (PITR) surface for a database application. Read-only
 * status plus a "restore as of" action that clones into a fresh install. Gated
 * per-app by ownership (owner/admin), unlike the admin-only Management→Backup
 * plane. Backup enablement/policy management stays on the backup-policies plane.
 */
@ApiTags('Database Console')
@UseGuards(PlatformFoundationGuard, AppOwnershipGuard)
@Controller('applications/:id/db-pitr')
export class DbPitrController {
  constructor(private readonly pitr: DbPitrService) {}

  @Get('status')
  @ApiOperation({ summary: 'Continuous-backup (PITR) status for a DB app' })
  status(@Param('id') id: string): Promise<DbPitrStatus> {
    return this.pitr.status(id);
  }

  @Post('restore')
  @ApiOperation({
    summary: 'Restore this database as-of a point in time into a new install',
  })
  restore(
    @Param('id') id: string,
    @Body() dto: DbPitrRestoreDto,
    @Request() req: { user: AuthenticatedUser },
  ) {
    return this.pitr.restore(req.user.userId, id, dto);
  }
}
