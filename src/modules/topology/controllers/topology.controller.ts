import { Controller, Get, Query, Req, Sse } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Observable } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import {
  TopologyEventsService,
  TopologyChange,
} from '../services/topology-events.service';
import {
  TopologyResponseDto,
  TopologyStreamMessageDto,
} from '../dto/topology.dto';
import {
  TopologyScopeService,
  applyScope,
  exampleScope,
  scopeChange,
} from '../services/topology-scope.service';
import { TopologyEventType } from '../enums/topology.enums';
import { TopologyService } from '../services/topology.service';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { SANDBOX_GUEST_REQUEST } from '../../sandbox/guards/sandbox-fence.guard';
import {
  exampleTopology,
  exampleTopologyStream,
} from '../../sandbox/stand-in/sandbox-world-topology';

interface TopologyRequest {
  user: AuthenticatedUser;
  [SANDBOX_GUEST_REQUEST]?: unknown;
}

@ApiTags('Topology')
@ApiBearerAuth()
@Controller('topology')
export class TopologyController {
  constructor(
    private readonly eventsService: TopologyEventsService,
    private readonly scopeService: TopologyScopeService,
    private readonly topologyService: TopologyService,
  ) {}

  @Get()
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'Full topology snapshot (clusters → servers → apps)',
    description:
      'Powers the dashboard topology. Refreshed every 10s and narrowed to the clusters ' +
      'and applications the caller may read.',
  })
  @ApiResponse({ status: 200, type: TopologyResponseDto })
  @ApiQuery({
    name: 'system',
    required: false,
    description:
      'Include the apps Flui itself runs; shown only to callers who see every cluster',
  })
  async getTopology(
    @Req() req: TopologyRequest,
    @Query('system') system?: string,
  ): Promise<TopologyResponseDto> {
    const includeSystem = isOn(system);
    // A guest sees the example organisation, answered here rather than by the
    // fence's stand-in so the response still passes through mask mode.
    if (req[SANDBOX_GUEST_REQUEST]) {
      const world = exampleTopology(Date.now());
      return applyScope(world, exampleScope(world, includeSystem));
    }
    const snapshot = await this.eventsService.snapshot();
    // Local development only: the example world has no permissions to narrow by.
    if (this.topologyService.isMockMode()) {
      return applyScope(snapshot, exampleScope(snapshot, includeSystem));
    }
    return this.scopeService.scope(req.user, snapshot, includeSystem);
  }

  @Sse('stream')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'Live topology change stream (Server-Sent Events)',
    description:
      'Emits app.status_changed, app.scaled, app.deployed, app.removed, server.added, ' +
      'server.removed, server.capacity (every 30s, changed servers only), links.changed, ' +
      'plus a heartbeat every 15s. Narrowed to what the caller may read. Connect after ' +
      'GET /topology and patch the snapshot.',
  })
  @ApiResponse({ status: 200, type: TopologyStreamMessageDto })
  @ApiQuery({ name: 'system', required: false })
  stream(
    @Req() req: TopologyRequest,
    @Query('system') system?: string,
  ): Observable<TopologyStreamMessageDto> {
    const includeSystem = isOn(system);
    const example = exampleScope(exampleTopology(Date.now()), includeSystem);
    const changes =
      req[SANDBOX_GUEST_REQUEST] || this.topologyService.isMockMode()
        ? exampleTopologyStream().pipe(
            map((change) =>
              change.event === TopologyEventType.HEARTBEAT
                ? change
                : scopeChange(change, example),
            ),
            filter((change): change is TopologyChange => change !== null),
          )
        : this.scopeService.scopeStream(
            req.user,
            this.eventsService.changes$,
            () => this.eventsService.snapshot(),
            includeSystem,
          );
    return changes.pipe(
      map((change: TopologyChange) => ({
        type: change.event,
        data: change.data,
      })),
    );
  }
}

function isOn(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}
