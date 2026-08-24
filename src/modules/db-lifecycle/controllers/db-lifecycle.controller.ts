import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { DbReplicationService } from '../services/db-replication.service';
import { ReplicateDto } from '../dto/replicate.dto';

/**
 * Same-cluster logical-replication primitives (Stage 2) — the building blocks
 * the future live-migration state machine composes. Management-plane / admin
 * gated, like the rest of the backup/restore infra.
 */
@ApiTags('DB Lifecycle')
@ApiBearerAuth()
@Controller('db-replication')
@RequireSection('backup')
export class DbLifecycleController {
  constructor(private readonly repl: DbReplicationService) {}

  @Post('fence/:appId')
  @ApiOperation({ summary: 'Soft-fence a database (default new tx read-only)' })
  async fence(@Param('appId') appId: string) {
    await this.repl.fence(appId);
    return { ok: true };
  }

  @Post('unfence/:appId')
  @ApiOperation({ summary: 'Lift a soft fence' })
  async unfence(@Param('appId') appId: string) {
    await this.repl.unfence(appId);
    return { ok: true };
  }

  @Post('replicate')
  @ApiOperation({
    summary:
      'Start logical replication src → dst (same cluster or cross-cluster)',
  })
  replicate(@Body() dto: ReplicateDto) {
    return this.repl.replicateTo(dto.srcAppId, dto.dstAppId, dto.transport);
  }

  @Get('links/:id/status')
  @ApiOperation({
    summary: 'Replication link status (lag, slot, subscription)',
  })
  status(@Param('id') id: string) {
    return this.repl.replicationStatus(id);
  }

  @Post('links/:id/promote')
  @ApiOperation({
    summary: 'Promote destination to standalone (drain + resync)',
  })
  promote(@Param('id') id: string) {
    return this.repl.promote(id);
  }

  @Post('links/:id/refresh')
  @ApiOperation({
    summary: 'Pick up publisher schema drift (new tables) into the subscriber',
  })
  refresh(@Param('id') id: string) {
    return this.repl.refresh(id);
  }

  @Delete('links/:id')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ApiOperation({
    summary: 'Abort a link: tear down subscription, slot and publication',
  })
  abort(@Param('id') id: string) {
    return this.repl.abort(id);
  }
}
