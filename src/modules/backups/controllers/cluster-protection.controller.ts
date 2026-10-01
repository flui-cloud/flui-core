import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { DataDoor } from '../../iam/decorators/data-door.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { ProtectClusterDto } from '../dto/protect-cluster.dto';
import {
  ClusterProtectionService,
  ClusterProtectionView,
} from '../services/cluster-protection.service';
import {
  ClusterDecisionsService,
  NeedsDecisionItem,
} from '../services/cluster-decisions.service';

@ApiTags('Backups')
@ApiBearerAuth()
@Controller('clusters/:clusterId/backups')
@RequireSection('backup')
export class ClusterProtectionController {
  constructor(
    private readonly protection: ClusterProtectionService,
    private readonly decisions: ClusterDecisionsService,
  ) {}

  private userId(req: Request): string {
    const u = req.user as { userId?: string; id?: string } | undefined;
    return u?.id ?? u?.userId ?? '00000000-0000-0000-0000-000000000000';
  }

  @Get('protection')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'How this cluster is protected',
    description:
      'Whether every application on the cluster gets a backup policy of its own (new ones included), what the last pass decided for each application, and the volumes that need a decision.',
  })
  get(@Param('clusterId') clusterId: string): Promise<ClusterProtectionView> {
    return this.protection.view(clusterId);
  }

  @Post('protection')
  @DataDoor()
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ApiOperation({
    summary: 'Protect every application on this cluster',
    description:
      'Gives each application a policy with the engine that fits it (continuous backup or dumps for a recognised database, deduplicated volume copies for the rest) and keeps doing so for applications installed later. Runs as an operation; the policies it creates are ordinary policies.',
  })
  start(
    @Req() req: Request,
    @Param('clusterId') clusterId: string,
    @Body() dto: ProtectClusterDto,
  ) {
    return this.protection.start(this.userId(req), clusterId, dto);
  }

  @Delete('protection')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ActionCycle({
    action: 'DELETE /clusters/:clusterId/backups/protection',
    bind: ['clusterId'],
    sentence: 'stop protecting new applications on cluster {clusterId}',
    consequence:
      'Applications installed on this cluster from now on get no backup policy unless somebody adds one. The policies already created keep running.',
  })
  @ApiOperation({
    summary: 'Stop protecting new applications on this cluster',
    description:
      'The policies already created keep running; applications installed from now on are not given one.',
  })
  stop(@Param('clusterId') clusterId: string) {
    return this.protection.stop(clusterId);
  }

  @Get('needs-decision')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'Volumes on this cluster no backup can take consistently',
    description:
      'Databases Flui does not recognise, and volumes the last copy refused because a database was writing to them. Each needs a person to choose: stop the application during the copy, or leave the volume out.',
  })
  needsDecision(
    @Param('clusterId') clusterId: string,
  ): Promise<NeedsDecisionItem[]> {
    return this.decisions.forCluster(clusterId);
  }
}
