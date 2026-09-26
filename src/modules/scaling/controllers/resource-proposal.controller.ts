import {
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import {
  AppAccessGuard,
  AppAction,
} from '../../applications/guards/app-access.guard';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ResourceProposalResponseDto } from '../dto/resource-proposal.dto';
import { ResourceProposalService } from '../services/resource-proposal.service';
import { MaintenanceService } from '../../infrastructure/maintenance/maintenance.service';
import { DeferredActionDto } from '../../infrastructure/maintenance/maintenance.dto';
import { byOf } from '../../infrastructure/scaling/scaling-actor';

@ApiTags('Application Management')
@ApiBearerAuth()
@UseGuards(AppAccessGuard)
@Controller('applications/:appId/resources/proposal')
export class ResourceProposalController {
  constructor(
    private readonly proposals: ResourceProposalService,
    private readonly maintenance: MaintenanceService,
  ) {}

  @Get()
  @AppAction(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary:
      'The memory change Flui proposes for an application, and what it would do',
    description:
      'Built from an open out-of-memory diagnosis and a week of memory use: a limit the app keeps reaching, or a reservation far below what it uses. Writes nothing. Each proposal carries its reasons, where the replicas would then run (a node already there, a machine a scaling group would buy or propose, or nowhere yet), whether applying restarts the application, and whether its own configuration must change too. `proposal` is null when nothing asks for a change.',
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiResponse({ status: 200, type: ResourceProposalResponseDto })
  proposal(
    @Param('appId') appId: string,
  ): Promise<ResourceProposalResponseDto> {
    return this.proposals.proposalOf(appId);
  }

  @Post('apply')
  @AppAction(IAM_PERMISSION.APP_WRITE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply the memory change Flui proposes',
    description:
      'Recomputes the proposal and applies it as it stands now, recording who applied it and why. The pods are replaced. Refused when nothing asks for a change any more, or when the values would be refused.',
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiResponse({ status: 200, type: ResourceProposalResponseDto })
  @ApiResponse({ status: 409, description: 'Nothing to apply' })
  apply(
    @Param('appId') appId: string,
    @Req() req: Request,
  ): Promise<ResourceProposalResponseDto> {
    const user = req.user as AuthenticatedUser | undefined;
    return this.proposals.apply(appId, {
      id: user?.userId,
      name: user?.email,
    });
  }

  @Post('defer')
  @AppAction(IAM_PERMISSION.APP_WRITE)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply the proposed memory change at the next maintenance window',
    description:
      "Holds it until the window that governs the application opens (its own, else its cluster's). The evidence is read again then: a reason that went away drops it, a change with nowhere to run is raised instead of applied. Refused with the reason when no window is set. Cancel it with DELETE /applications/:appId/deferred-actions/:id.",
  })
  @ApiParam({ name: 'appId', description: 'Application ID' })
  @ApiResponse({ status: 200, type: DeferredActionDto })
  @ApiResponse({
    status: 409,
    description: 'No window is set, or nothing asks for a change',
  })
  async defer(
    @Param('appId') appId: string,
    @Req() req: Request,
  ): Promise<DeferredActionDto> {
    const { proposal } = await this.proposals.proposalOf(appId);
    if (!proposal) {
      throw new ConflictException(
        'Nothing asks for a change; there is nothing to hold.',
      );
    }
    return this.maintenance.defer(
      'apply-resource-proposal',
      appId,
      byOf(req as never),
    );
  }
}
