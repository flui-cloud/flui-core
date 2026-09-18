import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { BackupDestinationsService } from '../services/backup-destinations.service';
import { CreateBackupDestinationDto } from '../dto/create-backup-destination.dto';
import { ObjectStoragePresetDto } from '../dto/object-storage-preset.dto';
import { ObjectStoragePresetsService } from '../../storage/services/object-storage-presets.service';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';

@ApiTags('Backups')
@ApiBearerAuth()
@Controller('backup-destinations')
@RequireSection('backup')
export class BackupDestinationsController {
  constructor(
    private readonly service: BackupDestinationsService,
    private readonly presets: ObjectStoragePresetsService,
  ) {}

  private userId(req: Request): string {
    const u = req.user as { userId?: string; id?: string } | undefined;
    return u?.id ?? u?.userId ?? '00000000-0000-0000-0000-000000000000';
  }

  // A destination's fields are substituted into manifests applied into the
  // cluster, into a pgBackRest configuration file and into a systemd unit on the
  // master — so creating one is an infrastructure act, and the sibling delete
  // already said so. The section alone let any account that can see the Backup
  // section create one.
  @Post()
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  async create(@Req() req: Request, @Body() dto: CreateBackupDestinationDto) {
    return this.service.create(this.userId(req), dto);
  }

  @Get()
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  async list(@Req() req: Request) {
    return this.service.list(this.userId(req));
  }

  /**
   * Declared before `:id` on purpose — Nest matches routes in order and would
   * otherwise read 'presets' as a destination id.
   */
  @Get('presets')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOkResponse({ type: [ObjectStoragePresetDto] })
  listPresets(): ObjectStoragePresetDto[] {
    return this.presets.list();
  }

  @Get(':id')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  async get(@Param('id') id: string) {
    return this.service.findById(id);
  }

  @Post(':id/test')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  async test(@Param('id') id: string) {
    return this.service.testConnection(id);
  }

  @Post(':id/refresh-usage')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  async refresh(@Param('id') id: string) {
    await this.service.refreshUsage(id);
    return { ok: true };
  }

  @Delete(':id')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  async remove(@Param('id') id: string) {
    await this.service.delete(id);
    return { ok: true };
  }
}
