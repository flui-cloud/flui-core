import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { TrafficWatchDto } from '../dto/traffic-watch.dto';
import { TrafficWatchService } from '../services/traffic-watch.service';
import { InstallationNowDto } from '../dto/installation-now.dto';
import { InstallationNowService } from '../services/installation-now.service';

@ApiTags('Observability')
@ApiBearerAuth()
@RequirePermission(IAM_PERMISSION.CLUSTER_READ)
@Controller('observability')
export class TrafficWatchController {
  constructor(
    private readonly watch: TrafficWatchService,
    private readonly now: InstallationNowService,
  ) {}

  @Get('traffic')
  @ApiOperation({
    summary:
      'Bandwidth of each node and the month at its current pace, requests arriving at each cluster, rate-limited and failed requests, with the thresholds that raise alerts',
  })
  async read(): Promise<TrafficWatchDto> {
    const {
      nodeMbps,
      monthlyTrafficPercent,
      spikeFactor,
      spikeMinRps,
      rateLimitedPer10m,
      edgeErrorPercent,
    } = this.watch.config;
    return {
      ...(await this.watch.read()),
      thresholds: {
        nodeMbps,
        monthlyTrafficPercent,
        spikeFactor,
        spikeMinRps,
        rateLimitedPer10m,
        edgeErrorPercent,
      },
    };
  }

  @Get('now')
  @ApiOperation({
    summary:
      'Everything that runs out first under a crowd, in one reading: nodes (CPU, memory, bandwidth, the month at its pace), requests at each cluster, platform components against their limits, the image registry over the last hour, the demo spaces and waiting list, and the alerts firing',
  })
  async installationNow(): Promise<InstallationNowDto> {
    return this.now.read();
  }
}
