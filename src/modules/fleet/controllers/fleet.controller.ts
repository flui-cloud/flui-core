import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { SECTION } from '../../iam/constants/iam-sections';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { FleetCoverage } from '../../backups/services/app-coverage.service';
import {
  FleetMetrics,
  FleetMetricsService,
} from '../services/fleet-metrics.service';
import { FleetAttentionService } from '../services/fleet-attention.service';
import { FLEET_WINDOWS, FleetWindow } from '../utils/fleet-metrics.aggregate';
import { NeedsYou } from '../utils/needs-you.rules';

@ApiTags('Fleet')
@ApiBearerAuth()
@Controller('fleet')
export class FleetController {
  constructor(
    private readonly metrics: FleetMetricsService,
    private readonly attention: FleetAttentionService,
  ) {}

  /*
   * The same gate as the per-cluster node metrics it is built from: a
   * fleet-wide reading must not answer to anyone the single-cluster one
   * refuses.
   */
  @Get('metrics')
  @RequireSection(SECTION.CLUSTERS)
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'CPU, memory, disk and network across every cluster',
    description:
      'The node readings of the cluster Monitoring page, for all clusters at once: ' +
      'percentages averaged over the nodes reporting at each instant, network summed. ' +
      'Each cluster says whether it is reporting, stale, has no data in the window, or ' +
      'could not be read; a cluster without readings is never counted as zero.',
  })
  @ApiQuery({ name: 'window', required: false, enum: ['1h', '3h', '24h'] })
  getMetrics(@Query('window') window?: string): Promise<FleetMetrics> {
    return this.metrics.getMetrics(parseWindow(window));
  }

  /*
   * `cluster:read`, the permission of the backup posture beside it, so an
   * agent key holding only the backup read scope can ask it. The rows are
   * still cut to the applications the caller may read.
   */
  @Get('backup-protection')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'Which applications a recent backup protects',
    description:
      'Every application the caller may read, with whether it holds data, the policy ' +
      'covering it (whole cluster, its namespace or its id; a label-selector policy is ' +
      'reported as to_verify) and the last successful backup. Protected means a covering ' +
      'policy succeeded within two runs of its schedule.',
  })
  @ApiQuery({ name: 'clusterId', required: false })
  getBackupProtection(
    @Req() req: Request,
    @Query('clusterId') clusterId?: string,
  ): Promise<FleetCoverage> {
    return this.attention.coverageFor(
      req.user as AuthenticatedUser,
      clusterId || undefined,
    );
  }

  @Get('needs-you')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'What asks for attention on the home',
    description:
      'Broken clusters, clusters being worked on, credentials that are not valid and ' +
      'applications holding data with no recent backup, most urgent first.',
  })
  getNeedsYou(@Req() req: Request): Promise<NeedsYou> {
    return this.attention.needsYou(req.user as AuthenticatedUser);
  }
}

function parseWindow(value?: string): FleetWindow {
  if (!value) return '3h';
  if (value in FLEET_WINDOWS) return value as FleetWindow;
  throw new BadRequestException(
    `window must be one of ${Object.keys(FLEET_WINDOWS).join(', ')}`,
  );
}
