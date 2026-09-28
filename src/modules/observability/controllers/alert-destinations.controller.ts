import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { SECTION } from '../../iam/constants/iam-sections';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { AlertDestinationsService } from '../services/alert-destinations.service';
import {
  AdminAlertRoutingDto,
  AlertDestinationDto,
  AlertDestinationTestResultDto,
  CreateAlertDestinationDto,
  CreatedAlertDestinationDto,
  UpdateAlertDestinationDto,
} from '../dto/alert-destination.dto';

/**
 * Where alerts go besides the bell: addresses and signed webhooks the
 * installation's operators add, and whether administrators are emailed
 * warnings as well as critical alerts.
 */
@ApiTags('Alerts')
@ApiBearerAuth()
@Controller('observability')
@RequireSection(SECTION.INFRASTRUCTURE)
export class AlertDestinationsController {
  constructor(private readonly destinations: AlertDestinationsService) {}

  @Get('alert-destinations')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'List alert destinations',
    description: 'Never returns a webhook signing secret.',
  })
  @ApiResponse({ status: 200, type: [AlertDestinationDto] })
  list(): Promise<AlertDestinationDto[]> {
    return this.destinations.list();
  }

  @Post('alert-destinations')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ActionCycle({
    action: 'POST /observability/alert-destinations',
    sentence: 'add a destination that receives this installation’s alerts',
    consequence:
      'Every alert at or above the chosen severity and within the chosen scope is sent there from now on, including the names of the nodes, and with scope all the applications, it is about.',
  })
  @ApiOperation({
    summary: 'Add an alert destination',
    description:
      'An email address, or an https webhook that receives a signed JSON POST. A webhook’s signing secret is in this response and never again. A destination hears infrastructure alerts unless its scope is `all`, which needs the data:access permission as well.',
  })
  @ApiResponse({ status: 201, type: CreatedAlertDestinationDto })
  @ApiResponse({
    status: 403,
    description: 'Scope `all` without the data:access permission.',
  })
  create(
    @Body() body: CreateAlertDestinationDto,
    @Req() req: Request,
  ): Promise<CreatedAlertDestinationDto> {
    const user = req.user as AuthenticatedUser | undefined;
    return this.destinations.create(body, user?.email ?? null, user);
  }

  @Patch('alert-destinations/:id')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ApiOperation({
    summary: 'Pause, resume, or change the severity floor or scope',
    description:
      'Widening a destination to scope `all` needs the data:access permission as well.',
  })
  @ApiResponse({ status: 200, type: AlertDestinationDto })
  @ApiResponse({
    status: 403,
    description: 'Scope `all` without the data:access permission.',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateAlertDestinationDto,
    @Req() req: Request,
  ): Promise<AlertDestinationDto> {
    return this.destinations.update(
      id,
      body,
      req.user as AuthenticatedUser | undefined,
    );
  }

  @Delete('alert-destinations/:id')
  @HttpCode(204)
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ActionCycle({
    action: 'DELETE /observability/alert-destinations/:id',
    bind: ['id'],
    sentence: 'remove alert destination {id}',
    consequence: 'Alerts stop being sent there.',
  })
  @ApiOperation({ summary: 'Remove an alert destination' })
  @ApiResponse({ status: 204 })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.destinations.remove(id);
  }

  @Post('alert-destinations/:id/test')
  @HttpCode(200)
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ActionCycle({
    action: 'POST /observability/alert-destinations/:id/test',
    bind: ['id'],
    sentence: 'send a test alert to destination {id}',
    consequence:
      'One message named FluiTestAlert is sent to that destination and nowhere else.',
  })
  @ApiOperation({
    summary: 'Send a test alert to one destination',
    description:
      'Delivers a synthetic FluiTestAlert to this destination only, whatever its severity floor, and returns the outcome.',
  })
  @ApiResponse({ status: 200, type: AlertDestinationTestResultDto })
  test(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AlertDestinationTestResultDto> {
    return this.destinations.test(id);
  }

  @Get('alert-routing/admins')
  @RequirePermission(IAM_PERMISSION.CLUSTER_READ)
  @ApiOperation({
    summary: 'Whether administrators are emailed warnings',
    description:
      'Administrators are always emailed critical alerts about what no application owns. This says whether warnings are emailed too.',
  })
  @ApiResponse({ status: 200, type: AdminAlertRoutingDto })
  async getAdmins(): Promise<AdminAlertRoutingDto> {
    return { warnings: await this.destinations.adminWarnings() };
  }

  @Put('alert-routing/admins')
  @RequirePermission(IAM_PERMISSION.CLUSTER_MANAGE)
  @ApiOperation({ summary: 'Email administrators warnings, or stop' })
  @ApiResponse({ status: 200, type: AdminAlertRoutingDto })
  async setAdmins(
    @Body() body: AdminAlertRoutingDto,
    @Req() req: Request,
  ): Promise<AdminAlertRoutingDto> {
    const user = req.user as AuthenticatedUser | undefined;
    return {
      warnings: await this.destinations.setAdminWarnings(
        body.warnings,
        user?.email ?? null,
      ),
    };
  }
}
