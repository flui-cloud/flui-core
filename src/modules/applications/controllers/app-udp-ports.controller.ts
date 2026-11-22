import { Controller, Get, Param, ParseUUIDPipe, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { AppUdpPortsService } from '../services/app-udp-ports.service';
import { AppUdpPortsDto } from '../dto/app-udp-ports.dto';

@ApiTags('Applications')
@ApiBearerAuth()
@Controller('applications/:id/udp-ports')
export class AppUdpPortsController {
  constructor(private readonly udpPorts: AppUdpPortsService) {}

  @Get()
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary:
      'The public UDP ports of an application and whether the cluster firewall opens them',
    description:
      'An install never opens a UDP port. Each one is reachable only once the cluster firewall has an inbound UDP rule for it, added from Cluster Firewalls by someone who manages the cluster.',
  })
  @ApiResponse({ status: 200, type: AppUdpPortsDto })
  get(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<AppUdpPortsDto> {
    return this.udpPorts.view(req.user as AuthenticatedUser, id);
  }
}
