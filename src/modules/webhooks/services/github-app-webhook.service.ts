import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as crypto from 'node:crypto';
import { GitHubIntegrationConfigService } from '../../repositories/services/github-integration-config.service';
import { GitHubAppService } from '../../repositories/services/github-app.service';

@Injectable()
export class GitHubAppWebhookService {
  private readonly logger = new Logger(GitHubAppWebhookService.name);

  constructor(
    private readonly integrationConfig: GitHubIntegrationConfigService,
    private readonly githubAppService: GitHubAppService,
  ) {}

  async validateSignature(payload: Buffer, signature: string): Promise<void> {
    const secret = await this.integrationConfig.getAppWebhookSecret();
    if (!secret) {
      throw new UnauthorizedException(
        'GitHub App webhook secret is not configured',
      );
    }

    const expected =
      'sha256=' +
      crypto.createHmac('sha256', secret).update(payload).digest('hex');

    if (
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    ) {
      throw new UnauthorizedException('Invalid webhook signature');
    }
  }

  async handleEvent(
    event: string,
    action: string | undefined,
    payload: any,
  ): Promise<{ received: boolean }> {
    this.logger.log(
      `GitHub App webhook: event=${event} action=${action ?? 'n/a'}`,
    );

    switch (event) {
      case 'installation':
        return this.handleInstallationEvent(action, payload);
      case 'workflow_run':
        return this.handleWorkflowRunEvent(action, payload);
      default:
        this.logger.debug(`Ignoring unhandled GitHub App event: ${event}`);
        return { received: true };
    }
  }

  private async handleInstallationEvent(
    action: string,
    payload: any,
  ): Promise<{ received: boolean }> {
    switch (action) {
      case 'created':
        // For managed Flui, we track the installation.
        // The userId linkage happens later via the dashboard connect flow.
        // For now, store with a placeholder userId that gets updated when the user connects.
        await this.githubAppService.handleInstallationCreated(
          payload,
          payload.sender?.login ?? 'unknown',
        );
        break;
      case 'deleted':
        await this.githubAppService.handleInstallationDeleted(payload);
        break;
      case 'suspend':
        await this.githubAppService.handleInstallationSuspended(payload);
        break;
      case 'unsuspend':
        await this.githubAppService.handleInstallationUnsuspended(payload);
        break;
      default:
        this.logger.debug(`Ignoring installation action: ${action}`);
    }
    return { received: true };
  }

  private async handleWorkflowRunEvent(
    action: string,
    payload: any,
  ): Promise<{ received: boolean }> {
    if (action !== 'completed') {
      this.logger.debug(`Ignoring workflow_run action: ${action}`);
      return { received: true };
    }

    const workflowRun = payload.workflow_run;
    if (!workflowRun) {
      this.logger.warn(
        'workflow_run.completed payload missing workflow_run field',
      );
      return { received: true };
    }

    // Only process runs triggered by a Flui workflow — the legacy shared
    // flui.yml or a per-app flui-<slug>.yml (the workflow name keeps the
    // "Flui Deploy" prefix in both cases).
    const isFlui =
      /\/flui[^/]*\.ya?ml$/.test(workflowRun.path ?? '') ||
      (workflowRun.name ?? '').startsWith('Flui Deploy');
    if (!isFlui) {
      this.logger.debug(`Ignoring non-Flui workflow run: ${workflowRun.name}`);
      return { received: true };
    }

    this.logger.log(
      `Workflow run completed: repo=${workflowRun.repository?.full_name} ` +
        `conclusion=${workflowRun.conclusion} sha=${workflowRun.head_sha?.slice(0, 7)}`,
    );

    // The actual build handling is delegated to ApplicationBuildWatcherService.
    // We emit the event data; the watcher service processes it.
    // This is wired via the handleWorkflowRunWebhook method that will be added
    // to the build watcher during phase 2.3 migration.
    // For now, we just log and acknowledge — the polling fallback handles it.

    return { received: true };
  }
}
