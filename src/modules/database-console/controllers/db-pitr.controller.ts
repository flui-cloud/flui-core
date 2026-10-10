import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Request,
  UseGuards,
  NotFoundException,
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
import { DataDoor } from '../../iam/decorators/data-door.decorator';
import { ApplicationAccessService } from '../../applications/services/application-access.service';
import { ApplicationsRepository } from '../../applications/repositories/applications.repository';

/**
 * DB-tab continuous-backup (PITR) surface for a database application. Read-only
 * status plus a "restore as of" action that clones into a fresh install. Gated
 * per-app by ownership (owner/admin), unlike the admin-only Management→Backup
 * plane. Backup enablement/policy management stays on the backup-policies plane.
 */
@ApiTags('Database Console')
@UseGuards(PlatformFoundationGuard, AppOwnershipGuard)
@DataDoor()
@Controller('applications/:id/db-pitr')
export class DbPitrController {
  constructor(
    private readonly pitr: DbPitrService,
    private readonly access: ApplicationAccessService,
    private readonly applications: ApplicationsRepository,
  ) {}

  @Get('status')
  @ApiOperation({ summary: 'Continuous-backup (PITR) status for a DB app' })
  status(@Param('id') id: string): Promise<DbPitrStatus> {
    return this.pitr.status(id);
  }

  @Post('restore')
  @ApiOperation({
    summary: 'Restore this database as-of a point in time into a new install',
  })
  async restore(
    @Param('id') id: string,
    @Body() dto: DbPitrRestoreDto,
    @Request() req: { user: AuthenticatedUser },
  ) {
    const source = await this.applications.findById(id);
    if (!source) throw new NotFoundException(`Application ${id} not found`);
    // The restore installs a new application: it passes the same gate as any
    // other creation, sandbox slot and pinned cluster included.
    await this.access.assertCanCreate(req.user, {
      clusterId: dto.clusterId ?? source.clusterId,
      projectId: source.projectId ?? undefined,
    });
    return this.pitr.restore(req.user.userId, id, dto);
  }
}
