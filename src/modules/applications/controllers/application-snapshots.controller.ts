import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
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

@ApiTags('Applications')
@ApiBearerAuth()
@Controller()
@UseGuards(AppAccessGuard)
export class ApplicationSnapshotsController {
  constructor(
    private readonly volumeSnapshotsService: VolumeSnapshotsService,
    private readonly volumeBackupsService: VolumeBackupsService,
    private readonly appManagementService: AppManagementService,
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
    body: { volumeName?: string; description?: string } = {},
  ) {
    return this.volumeSnapshotsService.createForApp({
      applicationId: id,
      userId: (req.user as AuthenticatedUser | undefined)?.userId,
      volumeName: body.volumeName,
      description: body.description,
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

  @Get('clusters/:clusterId/snapshots')
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

  // ── Volume backups (s3-archive sink) ──────────────────────────

  @Post('applications/:id/backups')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Archive an application volume to S3-compatible storage',
    description:
      'Spawns a copy-pod Job that streams the live PVC contents to S3 via rclone. ' +
      'When `destination` is omitted the bucket is auto-provisioned via the cluster ' +
      'provider object storage (Scaleway: full-auto using compute key; Hetzner: ' +
      'requires Object Storage credentials connected).',
  })
  @ApiParam({ name: 'id', description: 'Application ID' })
  async createBackup(
    @Param('id') id: string,
    @Req() req: Request,
    @Body()
    body: {
      volumeName?: string;
      description?: string;
      destination?: BackupDestination;
    } = {},
  ) {
    const userId = (req.user as AuthenticatedUser | undefined)?.userId;
    return this.volumeBackupsService.createForApp({
      applicationId: id,
      volumeName: body.volumeName,
      description: body.description,
      destination: body.destination,
      userId,
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
