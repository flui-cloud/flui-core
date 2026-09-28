import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
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
import {
  POLICY_ENGINE,
  PolicyEngine,
} from '../../iam/interfaces/policy-engine.interface';
import { principalOf } from '../../iam/interfaces/iam.types';
import { ActionCycle } from '../../action-cycle/action-cycle.decorator';
import { PlatformUpdatesService } from '../services/platform-updates.service';
import {
  DeclaredImageOutcome,
  DeclaredImageService,
} from '../services/declared-image.service';
import {
  ManifestRefreshService,
  RefreshPlan,
  RefreshResult,
} from '../services/manifest-refresh.service';
import { PlatformUpdateRunnerService } from '../services/platform-update-runner.service';
import { PlatformUpdateStatusDto } from '../dto/platform-update.dto';
import { PlatformUpdateOperationDto } from '../dto/platform-update-operation.dto';
import {
  PlanPlatformUpgradeDto,
  StartPlatformUpdateDto,
} from '../dto/start-platform-update.dto';
import { PlatformUpgradeService } from '../services/platform-upgrade.service';
import { PlatformUpgradePlan } from '../interfaces/platform-upgrade.interface';
import { actorFromRequest } from '../../auth/utils/actor.util';
import {
  ApplyManifestsDto,
  PlanManifestsDto,
} from '../dto/manifest-refresh.dto';
import { toPlatformUpdateOperationDto } from '../mappers/platform-update-operation.mapper';

/** Names the release in the sentence a person is asked to agree to, and a skipped backup. */
function targetVersionClause(body: unknown): string | undefined {
  const b = body as
    | { targetVersion?: unknown; withoutBackup?: unknown }
    | undefined;
  const version = b?.targetVersion;
  if (typeof version !== 'string' || !version.trim()) return undefined;
  return b?.withoutBackup === true
    ? `to ${version.trim()} without taking a backup first`
    : `to ${version.trim()}`;
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
    @Inject(POLICY_ENGINE) private readonly policy: PolicyEngine,
    private readonly upgrades?: PlatformUpgradeService,
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
      'Poll this while an update is in flight. It keeps answering across the API restart — from the outgoing pod, then from the one that replaced it. A planned update also reports its phases, each cluster it reached and, for K3s, every node.',
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
      outcome: DeclaredImageOutcome;
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
    @Req() req: Request,
    @Body() body: PlanManifestsDto,
  ): Promise<RefreshPlan> {
    await this.assertRefAllowed(req, body?.ref);
    return this.manifests.plan(body ?? {});
  }

  @Post('manifests/apply')
  @RequirePermission(IAM_PERMISSION.PLATFORM_UPDATE)
  @ApiOperation({
    summary: 'Apply a manifest plan that was previewed',
    description:
      'Recomputes the plan and refuses if it differs, so only what was previewed — against the state it was previewed on — can be written. It never writes a file that carries a Secret or needs a secret value, renders a templated file only with values proven for this installation (image tags are the ones running), and never deletes.',
  })
  async applyManifests(
    @Req() req: Request,
    @Body() body: ApplyManifestsDto,
  ): Promise<RefreshResult> {
    await this.assertRefAllowed(req, body.ref);
    return this.manifests.apply(body);
  }

  private async assertRefAllowed(req: Request, ref?: string): Promise<void> {
    if (await this.manifests.isPublishedRef(ref)) return;
    const allowed = await this.policy.check(
      principalOf(req),
      IAM_PERMISSION.PLATFORM_PREVIEW,
    );
    if (!allowed) {
      throw new ForbiddenException(
        `${ref} is not a published release. Refreshing from an unreleased ref needs ${IAM_PERMISSION.PLATFORM_PREVIEW}.`,
      );
    }
  }

  @Post('plan')
  @RequirePermission(IAM_PERMISSION.PLATFORM_UPDATE)
  @ApiOperation({
    summary:
      'Plan a platform update, phase by phase, without changing anything',
    description:
      'Backup, system manifests (the control first), platform images (the API last), K3s (workload clusters first, the control last) and the checks: what each would do, and what stops it. A missing platform backup is the one blocker an acknowledgement may pass. Reads each cluster, writes nothing. Apply with the plan id it returns.',
  })
  async plan(
    @Body() body: PlanPlatformUpgradeDto,
  ): Promise<PlatformUpgradePlan> {
    return this.upgradesService().plan(body?.targetVersion);
  }

  @Post(':id/resume')
  @RequirePermission(IAM_PERMISSION.PLATFORM_UPDATE)
  @ActionCycle({
    action: 'POST /platform/updates/:id/resume',
    bind: ['id'],
    sentence: 'resume the stopped platform update {id}',
    consequence:
      'The update carries on from the phase and cluster it stopped at; nothing done before is repeated or undone.',
  })
  @ApiOperation({
    summary: 'Resume a planned update that stopped',
    description:
      'Starts the phase that failed again, from the cluster it reached. Every phase first checks what is already in place, so nothing done is repeated.',
  })
  @ApiResponse({ status: 201, type: PlatformUpdateOperationDto })
  async resume(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PlatformUpdateOperationDto> {
    return toPlatformUpdateOperationDto(
      await this.upgradesService().resume(id),
    );
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
      'With a plan id: runs the planned update — backup, manifests, images, K3s, checks — and refuses when the plan changed since it was read. Without one: moves the component images only, components first and the API last, and refuses a release that also changes K3s or the manifests. Refuses when a release is already being applied or the offered release changed.',
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
    const user = req.user as AuthenticatedUser | undefined;
    if (dto.planId) {
      const actor = actorFromRequest(req as never);
      const operation = await this.upgradesService().apply(
        {
          targetVersion: dto.targetVersion,
          planId: dto.planId,
          withoutBackup: dto.withoutBackup,
          acknowledgement: dto.acknowledgement,
        },
        {
          userId: user?.userId,
          email: user?.email,
          actorKind: actor.kind,
          actorKeyId: actor.keyId ?? null,
        },
      );
      return toPlatformUpdateOperationDto(operation);
    }
    const operation = await this.runner.start(dto.targetVersion, user?.userId);
    return toPlatformUpdateOperationDto(operation);
  }

  private upgradesService(): PlatformUpgradeService {
    if (!this.upgrades) throw new Error('Planned updates are not available.');
    return this.upgrades;
  }
}
