import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { Request } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { RequireSection } from '../../iam/decorators/require-section.decorator';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { SECTION } from '../../iam/constants/iam-sections';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { PlatformUpdatesService } from '../services/platform-updates.service';
import { PlatformUpdateRunnerService } from '../services/platform-update-runner.service';
import { PlatformUpdateStatusDto } from '../dto/platform-update.dto';
import { PlatformUpdateOperationDto } from '../dto/platform-update-operation.dto';
import { StartPlatformUpdateDto } from '../dto/start-platform-update.dto';
import { toPlatformUpdateOperationDto } from '../mappers/platform-update-operation.mapper';

/** Names the release in the sentence a person is asked to agree to. */
function targetVersionClause(body: unknown): string | undefined {
  const version = (body as { targetVersion?: unknown } | undefined)
    ?.targetVersion;
  return typeof version === 'string' && version.trim()
    ? `to ${version.trim()}`
    : undefined;
}

@ApiTags('Platform Updates')
@ApiBearerAuth()
@Controller('platform/updates')
@RequireSection(SECTION.INFRASTRUCTURE)
export class PlatformUpdatesController {
  constructor(
    private readonly platformUpdates: PlatformUpdatesService,
    private readonly runner: PlatformUpdateRunnerService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Platform update status',
    description:
      'Compares the release this installation runs against the published release manifest: what is installed, what is available, which components a release would move, and what applying it would entail. Cached; use the check endpoint to refresh.',
  })
  @ApiResponse({ status: 200, type: PlatformUpdateStatusDto })
  async getStatus(): Promise<PlatformUpdateStatusDto> {
    return this.platformUpdates.getStatus();
  }

  @Post('check')
  @ApiOperation({
    summary: 'Re-read the release manifest now',
    description:
      'Bypasses the cache and returns the refreshed status. Reads a public manifest and changes nothing on the installation.',
  })
  @ApiResponse({ status: 201, type: PlatformUpdateStatusDto })
  async check(): Promise<PlatformUpdateStatusDto> {
    return this.platformUpdates.getStatus(true);
  }

  @Get('current')
  @ApiOperation({
    summary: 'The update running right now, if any',
    description:
      'Poll this while an update is in flight. It keeps answering across the API restart — from the outgoing pod, then from the one that replaced it.',
  })
  @ApiResponse({ status: 200, type: PlatformUpdateOperationDto })
  async current(): Promise<PlatformUpdateOperationDto | null> {
    const operation = await this.runner.findRunning();
    return operation ? toPlatformUpdateOperationDto(operation) : null;
  }

  @Get('history')
  @ApiOperation({ summary: 'Past platform updates, newest first' })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: [PlatformUpdateOperationDto] })
  async history(
    @Query('limit') limit?: string,
  ): Promise<PlatformUpdateOperationDto[]> {
    const operations = await this.runner.history(
      limit ? Number.parseInt(limit, 10) : 20,
    );
    return operations.map(toPlatformUpdateOperationDto);
  }

  @Post()
  @RequirePermission(IAM_PERMISSION.PLATFORM_UPDATE)
  // Deliberately unbindable: the route carries no parameter, so there is no
  // edge to pin an "always" to — and there should not be. Each release is a
  // different set of images and a different set of migrations, so consenting to
  // one is not consenting to the next. The clause names the release, which is
  // the only thing that tells the person deciding what they are agreeing to.
  @ActionCycle({
    action: 'POST /platform/updates',
    sentence: 'update this installation to a newer Flui release',
    clause: targetVersionClause,
    consequence:
      'The control plane is replaced and applies database migrations a rollback does not undo; the API is unavailable while it restarts.',
  })
  @ApiOperation({
    summary: 'Apply a platform release',
    description:
      'Queues the update: components first, the API last. Refuses when a release is already being applied, when the offered release has changed since it was read, or when the release needs the CLI.',
  })
  @ApiResponse({ status: 201, type: PlatformUpdateOperationDto })
  @ApiResponse({
    status: 400,
    description:
      'Nothing to update, or the release cannot be applied from here',
  })
  @ApiResponse({
    status: 409,
    description: 'Another update is running, or the offered release changed',
  })
  async start(
    @Req() req: Request,
    @Body() dto: StartPlatformUpdateDto,
  ): Promise<PlatformUpdateOperationDto> {
    const userId = (req.user as AuthenticatedUser | undefined)?.userId;
    const operation = await this.runner.start(dto.targetVersion, userId);
    return toPlatformUpdateOperationDto(operation);
  }
}
