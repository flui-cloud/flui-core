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
import { DeclaredImageService } from '../services/declared-image.service';
import {
  ManifestRefreshService,
  RefreshPlan,
  RefreshResult,
} from '../services/manifest-refresh.service';
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
    private readonly declaredImages: DeclaredImageService,
    private readonly manifests: ManifestRefreshService,
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

  @Post('reconcile-declared')
  @RequirePermission(IAM_PERMISSION.PLATFORM_UPDATE)
  @ApiOperation({
    summary: 'Declare the images that are actually running',
    description:
      'An update moves the running components and nothing else, so the manifests on the master keep naming the tags the cluster was installed with — and k3s hands those back the next time it reads that directory, undoing the update with no error and nothing to blame. This writes what is running into what is declared. It changes no running component: if the two already agree, it does nothing at all.',
  })
  async reconcileDeclared(): Promise<{
    images: Array<{
      image: string;
      pinned: boolean;
      files: string[];
      reason?: string;
    }>;
  }> {
    return { images: await this.declaredImages.reconcile() };
  }

  @Post('manifests/plan')
  @RequirePermission(IAM_PERMISSION.PLATFORM_UPDATE)
  @ApiOperation({
    summary:
      'What a release would change in the manifests on the master, without changing it',
    description:
      'Compares the files k3s re-applies at every start with the ones a release ships, and reports what it would replace, what it would add, and — the part that matters — what it will not touch and why. Writes nothing. The plan id it returns is what the apply call must be given.',
  })
  async planManifests(
    @Body()
    body: {
      ref?: string;
      only?: string[];
      allowStatefulImageChange?: boolean;
    },
  ): Promise<RefreshPlan> {
    return this.manifests.plan(body ?? {});
  }

  @Post('manifests/apply')
  @RequirePermission(IAM_PERMISSION.PLATFORM_UPDATE)
  @ApiOperation({
    summary: 'Apply a manifest plan that was previewed',
    description:
      'Recomputes the plan and refuses if it differs, so only what was previewed — against the state it was previewed on — can be written. It never writes a file that carries a Secret, never supplies a value, and never deletes.',
  })
  async applyManifests(
    @Body()
    body: {
      planId: string;
      ref?: string;
      only?: string[];
      allowStatefulImageChange?: boolean;
    },
  ): Promise<RefreshResult> {
    return this.manifests.apply(body);
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
