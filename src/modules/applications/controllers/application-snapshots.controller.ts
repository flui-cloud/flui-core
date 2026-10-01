import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiBearerAuth,
  ApiParam,
} from '@nestjs/swagger';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AppAccessGuard } from '../guards/app-access.guard';
import { AppManagementService } from '../services/app-management.service';
import { VolumeSnapshotsService } from '../services/volume-snapshots.service';
import {
  VolumeBackupsService,
  BackupDestination,
} from '../services/volume-backups.service';
import { ApplicationVolumeResizeService } from '../services/application-volume-resize.service';
import { SpareVolumesService } from '../services/spare-volumes.service';
import { VolumeBackupRestoreService } from '../services/volume-backup-restore.service';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { DataDoor } from '../../iam/decorators/data-door.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

@ApiTags('Applications')
@ApiBearerAuth()
@Controller()
@UseGuards(AppAccessGuard)
export class ApplicationSnapshotsController {
  constructor(
    private readonly volumeSnapshotsService: VolumeSnapshotsService,
    private readonly volumeBackupsService: VolumeBackupsService,
    private readonly appManagementService: AppManagementService,
    private readonly volumeResizeService: ApplicationVolumeResizeService,
    private readonly spareVolumes: SpareVolumesService,
    private readonly volumeBackupRestore: VolumeBackupRestoreService,
  ) {}

  // ── Volume snapshots ──────────────────────────────────────

  @Post('applications/:id/snapshots')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a snapshot of the application volume',
    description:
      'Creates an in-cluster PVC clone via the copy-pod export primitive. ' +
      'Returns the snapshot id and provider capabilities so the caller can surface cost expectations.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  async createSnapshot(
    @Req() req: Request,
    @Param('id') id: string,
    @Body()
    body: {
      volumeName?: string;
      description?: string;
      allowInconsistent?: boolean;
      pause?: boolean;
    } = {},
  ) {
    return this.volumeSnapshotsService.createForApp({
      applicationId: id,
      userId: (req.user as AuthenticatedUser | undefined)?.userId,
      volumeName: body.volumeName,
      description: body.description,
      allowInconsistent: body.allowInconsistent,
      pause: body.pause,
    });
  }

  @Get('applications/:id/snapshots')
  @ApiOperation({
    summary: 'List snapshots for an application',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  async listSnapshotsForApp(@Param('id') id: string) {
    return this.volumeSnapshotsService.listForApp(id);
  }

  @Delete('applications/:id/snapshots/:snapshotId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a snapshot of an application',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'snapshotId', description: 'Snapshot identifier' })
  async deleteSnapshot(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('snapshotId') snapshotId: string,
  ): Promise<{ operationId: string }> {
    return this.volumeSnapshotsService.deleteForApp(
      id,
      snapshotId,
      (req.user as AuthenticatedUser | undefined)?.userId,
    );
  }

  @Post('applications/:id/snapshots/:snapshotId/restore')
  @DataDoor()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Restore a snapshot into a new side-by-side PVC',
    description:
      'Creates a brand new PVC in the application namespace populated with the snapshot contents via a copy-pod Job. ' +
      'The live application is NOT touched. To make the application use the new PVC, call POST /applications/:id/volumes/:volumeName/swap.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'snapshotId', description: 'Snapshot identifier' })
  async restoreSnapshot(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('snapshotId') snapshotId: string,
  ) {
    return this.volumeSnapshotsService.restoreForApp(
      id,
      snapshotId,
      (req.user as AuthenticatedUser | undefined)?.userId,
    );
  }

  @Post('applications/:id/volumes/:volumeName/swap')
  @DataDoor()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Swap an application volume PVC',
    description:
      'Atomically rebinds the application Deployment volume to a different existing PVC. ' +
      'Typically called after POST /snapshots/:snapshotId/restore to promote the restored PVC. ' +
      'Old PVC is left intact as a backup; clean it up manually when no longer needed.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({
    name: 'volumeName',
    description: 'Application volume name (matches the entry in app.volumes)',
  })
  async swapVolume(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('volumeName') volumeName: string,
    @Body() body: { newClaimName: string },
  ) {
    if (!body?.newClaimName) {
      throw new BadRequestException('newClaimName is required');
    }
    return this.appManagementService.swapVolumeClaim(
      id,
      volumeName,
      body.newClaimName,
      (req.user as AuthenticatedUser | undefined)?.userId,
    );
  }

  @Get('applications/:id/volumes/spare')
  @ApiOperation({
    summary: 'Restored and previous volumes the application does not run on',
    description:
      'A copy restored beside the application and not put in use, and the data it ran on before a swap. Each is a full volume and is paid for.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  async listSpareVolumes(@Param('id') id: string) {
    return this.spareVolumes.list(id);
  }

  @Delete('applications/:id/volumes/spare/:name')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary:
      'Delete a restored or previous volume the application does not use',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'name', description: 'The volume, from the list' })
  async deleteSpareVolume(
    @Param('id') id: string,
    @Param('name') name: string,
  ): Promise<void> {
    await this.spareVolumes.remove(id, name);
  }

  // ── Volume size ───────────────────────────────────────────

  @Get('applications/:id/volumes/resize-plan')
  @ApiOperation({
    summary: 'Whether each volume of this application can be made bigger',
    description:
      'Answers without changing anything, so a caller can explain a refusal before asking for a size. ' +
      "A volume can only grow where its storage class allows it, which on Flui's default local-path classes it does not.",
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  async volumeResizePlan(@Param('id') id: string) {
    return this.volumeResizeService.planForApplication(id);
  }

  @Post('applications/:id/volumes/:volumeName/resize')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Make one application volume bigger',
    description:
      'Volumes only grow, never shrink. The answer says whether the application has to restart ' +
      'before the extra space becomes usable, which depends on the storage driver.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'volumeName', description: 'Name of the volume to grow' })
  async resizeVolume(
    @Param('id') id: string,
    @Param('volumeName') volumeName: string,
    @Body() body: { sizeGb: number },
  ) {
    if (typeof body?.sizeGb !== 'number') {
      throw new BadRequestException('sizeGb is required');
    }
    return this.volumeResizeService.resize(id, volumeName, body.sizeGb);
  }

  @Get('clusters/:clusterId/snapshots')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'List snapshots cluster-wide (all apps)',
    description:
      'Iterates over namespaces of active applications in the cluster and returns all flui-managed snapshots. ' +
      'Useful for global audit and orphan detection.',
  })
  @ApiParam({ name: 'clusterId', description: 'Cluster ID' })
  async listSnapshotsForCluster(@Param('clusterId') clusterId: string) {
    return this.volumeSnapshotsService.listForCluster(clusterId);
  }

  // ── Volume backups: list, look inside, restore ───────────────

  @Get('applications/:id/volume-backups')
  @ApiOperation({
    summary: "The application's volume backups, newest first",
    description:
      'Every copy of its volumes in the ledger: kopia snapshots, archives written before kopia, and clones on the cluster. ' +
      'Each says what a restore writes back (logicalBytes), what it added to the destination (uploadedBytes), whether it is still stored, ' +
      'whether it is kept by retention or until someone deletes it, and whether single files can be listed and restored from it.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  async listVolumeBackups(@Param('id') id: string) {
    return this.volumeBackupRestore.list(id);
  }

  @Get('applications/:id/volume-backups/:backupId/files')
  @DataDoor()
  @ApiOperation({
    summary: 'List the files of a directory inside a kopia volume backup',
    description:
      'Reads the snapshot read-only; nothing is restored. `path` is relative to the volume root (default: the root). ' +
      'Files copied with SQLite online backup are marked `consistentCopy`.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'backupId', description: 'Volume backup id' })
  async browseVolumeBackup(
    @Param('id') id: string,
    @Param('backupId') backupId: string,
    @Query('path') path?: string,
  ) {
    return this.volumeBackupRestore.browse(id, backupId, path);
  }

  @Post('applications/:id/volume-backups/:backupId/restore')
  @DataDoor()
  @ActionCycle({
    action: 'POST /applications/:id/volume-backups/:backupId/restore',
    bind: ['id'],
    sentence: 'restore volume backups of application {id} into new volumes',
    consequence:
      'New volumes the size of the backup are created on the cluster; the running application keeps its current data until its volume is swapped.',
  })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Restore a volume backup into a new volume',
    description:
      'Writes the whole backup into a new volume beside the application — this one, or `targetApplicationId`, which the caller must be allowed to change. ' +
      'The running application is not touched: make it use the new volume with POST /applications/:id/volumes/:volumeName/swap. ' +
      'Archives written before kopia restore the same way.',
  })
  @ApiParam({ name: 'id', description: 'Application ID the backup belongs to' })
  @ApiParam({ name: 'backupId', description: 'Volume backup id' })
  async restoreVolumeBackup(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('backupId') backupId: string,
    @Body() body: { targetApplicationId?: string; volumeName?: string } = {},
  ) {
    return this.volumeBackupRestore.restore(
      id,
      backupId,
      {
        targetApplicationId: body?.targetApplicationId,
        volumeName: body?.volumeName,
      },
      req.user as AuthenticatedUser | undefined,
    );
  }

  @Post('applications/:id/volume-backups/:backupId/restore-files')
  @DataDoor()
  @ActionCycle({
    action: 'POST /applications/:id/volume-backups/:backupId/restore-files',
    bind: ['id'],
    sentence: 'write files from volume backups back into application {id}',
    consequence:
      'The named files replace the ones the application has now, unless a separate directory is given; what they replace is not kept.',
  })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Restore selected files of a kopia volume backup into the volume',
    description:
      'Writes the named paths (files or directories, relative to the volume root) into the application volume, over the current ones — ' +
      'or under `targetDirectory` to keep both. A database file is written with its journal removed; stop the application first if it is writing to it.',
  })
  @ApiParam({ name: 'id', description: 'Application ID the backup belongs to' })
  @ApiParam({ name: 'backupId', description: 'Volume backup id' })
  async restoreVolumeBackupFiles(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('backupId') backupId: string,
    @Body()
    body: {
      paths: string[];
      targetDirectory?: string;
      targetApplicationId?: string;
      volumeName?: string;
    },
  ) {
    return this.volumeBackupRestore.restoreFiles(
      id,
      backupId,
      {
        paths: body?.paths,
        targetDirectory: body?.targetDirectory,
        targetApplicationId: body?.targetApplicationId,
        volumeName: body?.volumeName,
      },
      req.user as AuthenticatedUser | undefined,
    );
  }

  @Delete('applications/:id/volume-backups/:backupId')
  @ActionCycle({
    action: 'DELETE /applications/:id/volume-backups/:backupId',
    bind: ['id'],
    sentence: 'delete volume backups of application {id}',
    consequence:
      'That point in time can no longer be restored; other backups of the application are unaffected.',
  })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Delete a volume backup',
    description:
      'Removes the kopia snapshot (its space comes back at the next maintenance) or the archive, then its record. A clone on the cluster is removed with DELETE /applications/:id/snapshots/:snapshotId.',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({ name: 'backupId', description: 'Volume backup id' })
  async deleteVolumeBackup(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('backupId') backupId: string,
  ): Promise<{ operationId: string }> {
    return this.volumeBackupRestore.remove(
      id,
      backupId,
      req.user as AuthenticatedUser | undefined,
    );
  }

  // ── Volume backups: take one ──────────────────────────────────

  @Post('applications/:id/backups')
  @DataDoor()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Back up an application volume to S3-compatible storage',
    description:
      'Answers at once with an operation id; the copy runs in the background and its result (or the reason it was refused) ' +
      'is recorded on the operation (GET /infrastructure/operations/:id, `metadata.result` / `metadata.error`). ' +
      'With `destinationId` (a registered destination) the volume becomes a kopia snapshot in the ' +
      "application's encrypted, deduplicated repository on it, kept until deleted, recorded in the ledger, " +
      'listable and restorable whole or file by file. Raw `destination` credentials still work and ' +
      'archive a full plaintext copy through rclone. With neither, ' +
      'the bucket is auto-provisioned via the cluster provider object storage ' +
      '(Scaleway: full-auto using the compute key; Hetzner: requires Object ' +
      'Storage credentials connected; BYOS: no provisioner, pass one of the above).',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  async createBackup(
    @Param('id') id: string,
    @Req() req: Request,
    @Body()
    body: {
      volumeName?: string;
      description?: string;
      destinationId?: string;
      destination?: BackupDestination;
      allowInconsistent?: boolean;
      pause?: boolean;
    } = {},
  ) {
    const userId = (req.user as AuthenticatedUser | undefined)?.userId;
    return this.volumeBackupsService.startForApp({
      applicationId: id,
      volumeName: body.volumeName,
      description: body.description,
      destinationId: body.destinationId,
      destination: body.destination,
      userId,
      allowInconsistent: body.allowInconsistent,
      pause: body.pause,
    });
  }

  @Delete('applications/:id/backups/:exportId')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Delete an S3 backup of an application',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  @ApiParam({
    name: 'exportId',
    description: 'Export id (S3 key prefix) returned by create',
  })
  async deleteBackup(
    @Param('id') id: string,
    @Param('exportId') exportId: string,
    @Body() body: { destination: BackupDestination },
  ) {
    if (!body?.destination?.bucket) {
      throw new BadRequestException('destination.bucket is required');
    }
    await this.volumeBackupsService.deleteForApp({
      applicationId: id,
      exportId,
      destination: body.destination,
    });
  }
}
