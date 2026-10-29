import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { byOf } from '../scaling/scaling-actor';
import { AddHaNodeDto } from './dto/add-ha-node.dto';
import { HaNodesService } from './services/ha-nodes.service';

@ApiTags('Infrastructure - Clusters')
@ApiBearerAuth()
@Controller('infrastructure/clusters/:id/high-availability/nodes')
export class HaNodesController {
  constructor(private readonly service: HaNodesService) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ActionCycle({
    action: 'POST /infrastructure/clusters/:id/high-availability/nodes',
    bind: ['id'],
    sentence: 'add a node to cluster {id} for high availability',
    consequence:
      'Flui buys a machine in the chosen location and joins it to the cluster with its role: a server also runs the control plane and holds a vote, a node for data takes applications where copies of data live. The machine is billed from then on.',
  })
  @ApiOperation({
    summary: 'Add the server or the node for data a cluster still needs',
    description:
      'Adds what `GET /infrastructure/clusters/:id/high-availability` lists under `missing`, one node per call, with its role (`server` or `data-host`) and its location. Anything not missing is refused with the reason: a fourth server, or a second one in a location, changes the votes the control plane counts without making the cluster survive more. ' +
      'The node is added outside the scaling group, which never removes it. Returns the operation to follow. With two servers the cluster is more fragile than with one until the third joins, so add the second and the third one after the other.',
  })
  @ApiParam({ name: 'id', description: 'Cluster ID' })
  add(
    @Param('id') id: string,
    @Body() dto: AddHaNodeDto,
    @Req()
    req: { user?: { email?: string; displayName?: string } } & Record<
      string,
      unknown
    >,
  ) {
    return this.service.add(id, dto, byOf(req));
  }
}
