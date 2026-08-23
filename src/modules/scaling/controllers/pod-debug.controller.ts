import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { PodDebugService } from '../services/pod-debug.service';
import { PodDebugInfoDto } from '../dto/pod-debug.dto';
import { AppAccessGuard } from '../../applications/guards/app-access.guard';

/**
 * Pod-level diagnostics for one application: phase, containers, restart counts
 * and the Kubernetes events behind a failure.
 *
 * `AppAccessGuard` is on the class because everything under it is about a single
 * application named in the path. Without it the throttler was the only thing in
 * the way, and any authenticated caller could read the pods of anybody's
 * application — a guest's included, which is how it was found.
 */
@ApiTags('applications')
@ApiBearerAuth()
@Controller('applications/:id/debug')
@UseGuards(ThrottlerGuard, AppAccessGuard)
@Throttle({ default: { ttl: 60_000, limit: 10 } })
export class PodDebugController {
  constructor(private readonly podDebugService: PodDebugService) {}

  @Get('pods')
  @ApiOperation({
    summary: 'Return debug info for every pod of the application',
  })
  listPods(@Param('id') applicationId: string): Promise<PodDebugInfoDto[]> {
    return this.podDebugService.getPodsDebugInfo(applicationId);
  }

  @Get('pod/:podName')
  @ApiOperation({ summary: 'Return debug info for a specific pod' })
  getPod(
    @Param('id') applicationId: string,
    @Param('podName') podName: string,
  ): Promise<PodDebugInfoDto> {
    return this.podDebugService.getPodDebugInfo(applicationId, podName);
  }
}
