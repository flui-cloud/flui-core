import {
  Patch,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { BackupDestinationsService } from '../services/backup-destinations.service';
import { CreateBackupDestinationDto } from '../dto/create-backup-destination.dto';
import { UpgradeDestinationLayoutDto } from '../dto/upgrade-destination-layout.dto';
import { SetDestinationCostDto } from '../dto/set-destination-cost.dto';
import { ObjectStoragePresetDto } from '../dto/object-storage-preset.dto';
import { ObjectStoragePresetsService } from '../../storage/services/object-storage-presets.service';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { DataDoor } from '../../iam/decorators/data-door.decorator';

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
  @DataDoor()
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

  @Post(':id/upgrade-layout')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ApiOperation({
    summary: 'Give cluster backups a folder of their own in this destination',
    description:
      'Destinations created before this layout keep cluster backups at the top, where database, volume and platform backups make the storage unusable for cluster backups. Refused with the commands to move them when cluster backups are already there, unless force is set (they then stay in the bucket but are no longer listed until moved).',
  })
  async upgradeLayout(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: UpgradeDestinationLayoutDto,
  ) {
    return this.service.upgradeLayout(
      id,
      this.userId(req),
      dto?.force ?? false,
    );
  }

  @Patch(':id/cost')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ApiOperation({
    summary: 'Set what this storage costs',
    description:
      'The price per GB per month the backup estimates use for this destination. null returns to the published list price when Flui has one for the provider.',
  })
  async setCost(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: SetDestinationCostDto,
  ) {
    return this.service.setCost(id, this.userId(req), dto.costPerGbMonthCents);
  }

  @Delete(':id')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  async remove(@Param('id') id: string) {
    await this.service.delete(id);
    return { ok: true };
  }
}
