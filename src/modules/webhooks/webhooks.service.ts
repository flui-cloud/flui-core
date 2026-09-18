import { timingSafeEqual } from 'node:crypto';
import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationEntity } from '../applications/entities/application.entity';
import { ApplicationDeployService } from '../applications/services/application-deploy.service';
import { ApplicationSourceDeployService } from '../applications/services/application-source-deploy.service';
import { ApplicationEventsGateway } from '../applications/gateway/application-events.gateway';
import { ImageRegistryService } from '../image-registry/services/image-registry.service';
import { ApplicationStatus } from '../applications/enums/application-status.enum';
import { GitHubActionsWebhookDto } from './dto/github-actions-webhook.dto';
import { shouldAutoDeployOnBuild } from './webhooks.util';

/**
 * Handles incoming GitHub Actions build completion webhooks.
 * Validates the per-application HMAC token, then triggers K3s deploy on success
 * or marks the application as failed on build failure.
 */
/**
 * Constant-time, and length-guarded first: `timingSafeEqual` throws when the
 * buffers differ in length, which would turn a wrong-length token into a 500
 * instead of a 401 and leak the length by the difference.
 */
function sameToken(expected: string, presented: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly applicationRepository: Repository<ApplicationEntity>,
    private readonly applicationDeployService: ApplicationDeployService,
    private readonly applicationSourceDeployService: ApplicationSourceDeployService,
    private readonly applicationEventsGateway: ApplicationEventsGateway,
    private readonly imageRegistryService: ImageRegistryService,
  ) {}

  async handleGitHubActionsWebhook(
    token: string,
    dto: GitHubActionsWebhookDto,
  ): Promise<{ received: boolean }> {
    const app = await this.applicationRepository.findOne({
      where: { id: dto.appId },
    });

    // Same refusal for a missing application and a wrong token, so the route
    // cannot be used to ask which application ids exist.
    //
    // Each condition is stated separately because the single `!==` this replaces
    // was fail-OPEN: with no header and an unknown id both sides were
    // `undefined`, the comparison was false, and the request went through on a
    // route that is `@Public()`.
    if (!token || !app?.webhookToken || !sameToken(app.webhookToken, token)) {
      throw new UnauthorizedException('Invalid webhook token');
    }

    this.logger.log(
      `GitHub Actions webhook: appId=${dto.appId} status=${dto.status} branch=${dto.branch}`,
    );

    if (dto.status === 'failed') {
      await this.applicationRepository.update(dto.appId, {
        status: ApplicationStatus.FAILED,
      });

      this.applicationEventsGateway.emitBuildFailed(dto.appId, {
        appId: dto.appId,
        buildId: 'github-actions',
        operationId: 'github-actions',
        error: `GitHub Actions build failed on branch ${dto.branch} (commit ${dto.commitSha})`,
        timestamp: new Date(),
      });

      this.logger.warn(`Build failed for app ${dto.appId}`);
      return { received: true };
    }

    // status === 'success' — the desired image is set exclusively through
    // setDesiredImage (via triggerDeployWithImage below); never written raw here,
    // so it always goes through subPath validation + generation fencing.
    this.applicationEventsGateway.emitBuildCompleted(dto.appId, {
      appId: dto.appId,
      buildId: 'github-actions',
      imageRef: dto.imageRef ?? '',
      duration: 0,
      timestamp: new Date(),
    });

    // Record image in the registry for tracking and future rollbacks
    if (dto.imageRef) {
      try {
        await this.imageRegistryService.recordImage({
          appId: dto.appId,
          imageRef: dto.imageRef,
          commitSha: dto.commitSha,
          branch: dto.branch,
        });
      } catch (error) {
        this.logger.warn(
          `Failed to record image in registry: ${error.message}`,
        );
      }
    }

    // Auto-deploy on push is opt-in. For an app that is already live, only roll
    // out the new image when the owner enabled deployOnPush; otherwise the image
    // stays recorded as an available version for a manual deploy. The very first
    // deploy is never gated: the app is still in AWAITING_BUILD (not live) at
    // that point, so it always flows through below.
    if (!shouldAutoDeployOnBuild(app.status, app.deployOnPush)) {
      this.logger.log(
        `Auto-deploy on push disabled for app ${dto.appId}; recorded image ${dto.imageRef ?? '(none)'} without deploying`,
      );
      return { received: true };
    }

    // Re-read flui.yaml at the pushed commit BEFORE deploying, so a `git push`
    // applies the committed manifest (env, port, resources, …) like `flui deploy`
    // — not an image swap over stale DB env. Best-effort: never blocks the deploy.
    await this.applicationSourceDeployService.reapplyManifestAtCommit(
      dto.appId,
      dto.commitSha,
      dto.branch,
    );

    // Trigger K3s deployment with the new image (carries the refreshed env)
    if (dto.imageRef) {
      await this.applicationDeployService.triggerDeployWithImage(
        dto.appId,
        dto.imageRef,
      );
      this.logger.log(
        `Deploy triggered for app ${dto.appId} with image ${dto.imageRef}`,
      );
    }

    return { received: true };
  }
}
