import { Controller, Get, HttpCode, Param, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import {
  VeleroFootprint,
  VeleroUninstallService,
} from '../services/velero-uninstall.service';

/**
 * Velero was Flui's cluster-wide backup engine and has been removed. Clusters
 * that ran it still carry it until somebody takes it off with this.
 */
@ApiTags('Backups')
@ApiBearerAuth()
@Controller('clusters/:clusterId/backups/velero')
@RequireSection('backup')
export class VeleroUninstallController {
  constructor(private readonly uninstall: VeleroUninstallService) {}

  private userId(req: Request): string {
    const u = req.user as { userId?: string; id?: string } | undefined;
    return u?.id ?? u?.userId ?? '00000000-0000-0000-0000-000000000000';
  }

  @Get()
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'What the retired Velero engine left on this cluster',
    description:
      'Its controller, node agent, bucket credentials, cluster-wide binding, resource definitions and namespace, which of them are still present, the policies it ran (paused), and where the backups it wrote still are. Nothing is changed.',
  })
  inspect(@Param('clusterId') clusterId: string): Promise<VeleroFootprint> {
    return this.uninstall.inspect(clusterId);
  }

  @Post('uninstall')
  @HttpCode(202)
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ActionCycle({
    action: 'POST /clusters/:clusterId/backups/velero/uninstall',
    bind: ['clusterId'],
    sentence: 'remove Velero from cluster {clusterId}',
    consequence:
      'Its controller, node agent, bucket credentials, cluster-wide binding, resource definitions and namespace are deleted from the cluster. The backups it wrote stay in their destinations, and nothing on the cluster can restore them any more.',
  })
  @ApiOperation({
    summary: 'Remove the retired Velero engine from this cluster',
    description:
      'Runs as an operation and returns its id; running it again continues where an earlier run stopped, and while one runs the same id is returned. Only what Flui installed is removed. The data in the destinations is kept.',
  })
  start(@Req() req: Request, @Param('clusterId') clusterId: string) {
    return this.uninstall.start(this.userId(req), clusterId);
  }
}
