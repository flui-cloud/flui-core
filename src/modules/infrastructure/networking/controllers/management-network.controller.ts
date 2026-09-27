import { Body, Controller, Get, Put, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequireSection } from '../../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../../iam/constants/iam-permissions';
import { ActionCycle } from '../../../action-cycle/action-cycle.decorator';
import {
  ManagementNetworkDto,
  SetManagementNetworkDto,
} from '../dto/management-network.dto';
import { ManagementNetworkService } from '../services/management-network.service';

const SWITCH_CONSEQUENCE =
  'On: clusters on another provider than the control reach it, and are ' +
  'managed, over the Flui network. Off: nothing is torn down, but no new ' +
  'cluster joins it and clusters on another provider cannot be created.';

@ApiTags('Infrastructure - Flui network')
@ApiBearerAuth()
@Controller('infrastructure/management-network')
@RequireSection('infrastructure')
export class ManagementNetworkController {
  constructor(private readonly network: ManagementNetworkService) {}

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
    @Req() req: { user?: { email?: string; displayName?: string } },
  ): Promise<ManagementNetworkDto> {
    return this.network.set(
      body.enabled,
      req.user?.email ?? req.user?.displayName ?? 'a person',
    );
  }
}
