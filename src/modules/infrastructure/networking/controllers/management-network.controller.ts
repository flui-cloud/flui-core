import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequireSection } from '../../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../../iam/constants/iam-permissions';
import { ActionCycle } from '../../../action-cycle/action-cycle.decorator';
import {
  ManagementNetworkDto,
  OverlayDemotionDto,
  SetManagementNetworkDto,
} from '../dto/management-network.dto';
import { ManagementNetworkService } from '../services/management-network.service';
import { KubeconfigDemotionService } from '../services/kubeconfig-demotion.service';

type PersonRequest = { user?: { email?: string; displayName?: string } };

const personOf = (req: PersonRequest): string =>
  req.user?.email ?? req.user?.displayName ?? 'a person';

const SWITCH_CONSEQUENCE =
  'On: clusters on another provider than the control reach it, and are ' +
  'managed, over the Flui network. Off: nothing is torn down, but no new ' +
  'cluster joins it and clusters on another provider cannot be created.';

@ApiTags('Infrastructure - Flui network')
@ApiBearerAuth()
@Controller('infrastructure/management-network')
@RequireSection('infrastructure')
export class ManagementNetworkController {
  constructor(
    private readonly network: ManagementNetworkService,
    private readonly demotion: KubeconfigDemotionService,
  ) {}

  @Get()
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary:
      'The Flui network: on or off, why, the control end and its members',
    description:
      '`unavailable` names what makes it impossible here (for example a control with no reachable address). Each member carries its last handshake; `stale` means the tunnel has gone quiet.',
  })
  @ApiResponse({ status: 200, type: ManagementNetworkDto })
  status(): Promise<ManagementNetworkDto> {
    return this.network.status();
  }

  @Put()
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ActionCycle({
    action: 'PUT /infrastructure/management-network',
    sentence: 'switch the Flui network of this installation on or off',
    consequence: SWITCH_CONSEQUENCE,
  })
  @ApiOperation({
    summary: 'Switch the Flui network on or off for this installation',
    description:
      'Stored on the installation, so an installer refresh does not change it. Switching on is refused (400) with the reason when it cannot work here.',
  })
  @ApiResponse({ status: 200, type: ManagementNetworkDto })
  set(
    @Body() body: SetManagementNetworkDto,
    @Req() req: PersonRequest,
  ): Promise<ManagementNetworkDto> {
    return this.network.set(body.enabled, personOf(req));
  }

  @Post('clusters/:id/demote')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ActionCycle({
    action: 'POST /infrastructure/management-network/clusters/:id/demote',
    bind: ['id'],
    sentence:
      'move the API address of cluster {id} back off the Flui network, onto its public address',
    consequence:
      'Flui reaches the cluster on its public address again, and the public API port reopens to the control nodes. It stays there until the hold is released.',
  })
  @ApiOperation({
    summary:
      'Emergency: address a cluster on its public path again, off the Flui network',
    description:
      'Rewrites the stored API address of a workload cluster back to its first node’s public address and holds it there: the address is not moved back onto the Flui network until the hold is released (DELETE on the same path). Never triggered by health. Recorded in the audit log.',
  })
  @ApiParam({ name: 'id', description: 'Workload cluster ID' })
  @ApiResponse({ status: 201, type: OverlayDemotionDto })
  @ApiResponse({
    status: 400,
    description: 'The control cluster, or no public address to go back to',
  })
  demote(
    @Param('id') clusterId: string,
    @Req() req: PersonRequest,
  ): Promise<OverlayDemotionDto> {
    return this.demotion.demote(clusterId, personOf(req));
  }

  @Delete('clusters/:id/demote')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ActionCycle({
    action: 'DELETE /infrastructure/management-network/clusters/:id/demote',
    bind: ['id'],
    sentence:
      'release the hold that keeps cluster {id} on its public address, off the Flui network',
    consequence:
      'The regular sweep moves the cluster’s API address back onto the Flui network once every control node reaches it there.',
  })
  @ApiOperation({
    summary: 'Release the hold that keeps a cluster off the Flui network',
    description:
      'The cluster is moved back onto the Flui network by the regular sweep, and only once every control node reaches it there.',
  })
  @ApiParam({ name: 'id', description: 'Workload cluster ID' })
  @ApiResponse({ status: 200, type: OverlayDemotionDto })
  release(
    @Param('id') clusterId: string,
    @Req() req: PersonRequest,
  ): Promise<OverlayDemotionDto> {
    return this.demotion.release(clusterId, personOf(req));
  }
}
