import { Body, Controller, Get, Param, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { BackupArtifactRepository } from '../repositories/backup-artifact.repository';
import { BackupArtifactEntity } from '../entities/backup-artifact.entity';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { DbPitrService } from '../services/db-pitr.service';
import { DbPitrRestoreDto } from '../dto/db-pitr-restore.dto';
import { DataDoor } from '../../iam/decorators/data-door.decorator';
import {
  PlatformBackupDownload,
  PlatformBackupDownloadService,
} from '../services/platform-backup-download.service';

/**
 * One read surface over the ledger, covering every engine: a cluster snapshot,
 * a database's continuous backups and a single volume's copies are the same
 * kind of row and belong in the same list.
 */
@ApiTags('Backups')
@ApiBearerAuth()
@DataDoor()
@Controller('backup-artifacts')
@RequireSection('backup')
export class BackupArtifactsController {
  constructor(
    private readonly artifacts: BackupArtifactRepository,
    private readonly dbPitr: DbPitrService,
    private readonly platformDownload: PlatformBackupDownloadService,
  ) {}

  @Get('platform/download')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ApiOperation({
    summary: 'Links to fetch the two objects of a platform backup',
    description:
      'Ten-minute download links for the key bundle and the control-plane dump of one platform backup — the newest one when jobId is omitted. The storage credentials never leave the API; what is fetched is sealed to the operator key and opened with `flui backup platform restore`.',
  })
  platformBackupLinks(
    @Query('jobId') jobId?: string,
  ): Promise<PlatformBackupDownload> {
    return this.platformDownload.links(jobId || undefined);
  }

  @Get()
  @ApiOperation({
    summary: 'List backup artifacts for one application or one cluster',
  })
  async list(
    @Query('applicationId') applicationId?: string,
    @Query('clusterId') clusterId?: string,
  ): Promise<BackupArtifactEntity[]> {
    if (applicationId) {
      return this.artifacts.listForApplication(applicationId);
    }
    if (clusterId) {
      return this.artifacts.listForCluster(clusterId);
    }
    return [];
  }

  @Post(':id/restore-database')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ApiOperation({
    summary: 'Restore a database backup into a new database',
    description:
      'Works whether or not the source database still exists. Omit recoveryTargetTime for everything that was archived; the source cluster is used when clusterId is omitted and it still exists.',
  })
  async restoreDatabase(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: DbPitrRestoreDto,
  ) {
    const u = req.user as { userId?: string; id?: string } | undefined;
    return this.dbPitr.restoreArtifact(u?.id ?? u?.userId ?? '', id, dto);
  }
}
