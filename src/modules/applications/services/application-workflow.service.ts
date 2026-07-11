import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { v4 as uuidv4, validate as uuidValidate } from 'uuid';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { RepositoriesRepository } from '../../repositories/repositories/repositories.repository';
import {
  GitHubWorkflowService,
  WorkflowRunStatus,
  fluiWorkflowFileName,
} from '../../repositories/services/github-workflow.service';
import { GitHubTokenResolverService } from '../../repositories/services/github-token-resolver.service';
import { WorkflowGeneratorService } from '../../repositories/services/workflow-generator.service';
import { GithubAppUserAuthService } from '../../repositories/services/github-app-user-auth.service';
import { ApplicationStatus } from '../enums/application-status.enum';
import {
  ApplicationSourceConfig,
  GitBuildSourceConfig,
} from '../interfaces/source-config.interface';
import { ApplicationBuildWatcherService } from './application-build-watcher.service';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppBuildEntity } from '../../app-builds/entities/app-build.entity';
import { AppBuildStatus } from '../../app-builds/enums/app-build-status.enum';
import { BuildProvider } from '../../app-builds/enums/build-provider.enum';

export interface GenerateWorkflowDto {
  branch: string;
  framework: string;
  packageManager?: 'npm' | 'yarn' | 'pnpm';
  nodeVersion?: string;
  javaVersion?: string;
  dotnetVersion?: string;
  port?: number;
  buildTool?: 'maven' | 'gradle';
  appName?: string;
  force?: boolean;
}

export interface GenerateWorkflowV3Dto {
  branch: string;
  isFluiManaged?: boolean;
  force?: boolean;
  /** Dockerfile path relative to repo root (default: Dockerfile). */
  dockerfilePath?: string;
  /** Docker build context relative to repo root (default: .). */
  buildContext?: string;
  /** Monorepo sub-path: scopes the GHCR image name and the push paths filter. */
  subPath?: string;
}

export interface GenerateWorkflowResultDto {
  committed: boolean;
  workflowUrl: string;
  runId?: string;
}

/**
 * Orchestrates generating and committing GitHub Actions workflows for an application.
 */
@Injectable()
export class ApplicationWorkflowService {
  private readonly logger = new Logger(ApplicationWorkflowService.name);

  constructor(
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly repositoriesRepository: RepositoriesRepository,
    private readonly githubWorkflowService: GitHubWorkflowService,
    private readonly tokenResolver: GitHubTokenResolverService,
    private readonly workflowGeneratorService: WorkflowGeneratorService,
    private readonly configService: ConfigService,
    private readonly buildWatcher: ApplicationBuildWatcherService,
    @InjectRepository(AppBuildEntity)
    private readonly appBuildRepository: Repository<AppBuildEntity>,
    private readonly githubAppUserAuth: GithubAppUserAuthService,
  ) {}

  /**
   * Resolves the value to write into the `FLUI_GHCR_TOKEN` repo secret used
   * by the generated workflow's `docker/login-action` step. Order:
   *   1. User-saved GHCR Personal Access Token (preferred path in App mode —
   *      the App's installation token cannot push to GHCR).
   *   2. OAuth/PAT user access token (legacy path — only useful when the user
   *      authenticated with a token that already carries `write:packages`).
   * Returns `null` when neither is available; in that case the workflow falls
   * back to `secrets.GITHUB_TOKEN`, which works only if the workflow grants
   * `packages: write` AND the repo allows it.
   */
  private async resolveGhcrTokenForUser(
    userId: string,
    owner: string,
  ): Promise<string | null> {
    try {
      const pat = await this.githubAppUserAuth.getDecryptedGhcrPat(userId);
      if (pat) return pat;
    } catch (err) {
      this.logger.warn(
        `Could not read user GHCR PAT for ${userId}: ${err.message}`,
      );
    }
    if (!(await this.tokenResolver.isAppMode())) {
      try {
        return await this.githubWorkflowService.getUserAccessToken(
          userId,
          owner,
        );
      } catch (err) {
        this.logger.warn(
          `Could not read OAuth access token for ${userId}: ${err.message}`,
        );
      }
    }
    return null;
  }

  private async saveFluiGhcrSecret(
    userId: string,
    owner: string,
    repo: string,
  ): Promise<boolean> {
    const token = await this.resolveGhcrTokenForUser(userId, owner);
    if (!token) {
      this.logger.warn(
        `No GHCR token available for user ${userId}/${owner} — workflow will fall back to GITHUB_TOKEN, which requires the repository to allow it for GHCR pushes.`,
      );
      return false;
    }
    try {
      await this.githubWorkflowService.saveRepoSecret(
        userId,
        owner,
        repo,
        'FLUI_GHCR_TOKEN',
        token,
      );
      return true;
    } catch (err) {
      this.logger.error(
        `Failed to save FLUI_GHCR_TOKEN on ${owner}/${repo}: ${err.message}`,
        err.stack,
      );
      return false;
    }
  }

  /**
   * Records a provider-agnostic AppBuild row for an external build path
   * (today: GitHub Actions). Idempotent on (applicationId, provider) when
   * an active row already exists — the watcher will keep updating the same
   * row through to a terminal status.
   */
  private async recordExternalBuildStarted(params: {
    applicationId: string;
    provider: BuildProvider;
    branch: string;
    externalRunId?: string;
    externalUrl?: string;
    commitSha?: string;
    force?: boolean;
  }): Promise<AppBuildEntity> {
    if (params.commitSha) {
      await this.handleSameCommitTerminalBuild(params);
    }

    const existing = await this.findActiveBuild(params);
    if (existing) {
      const reused = await this.reconcileExistingActiveBuild(existing, params);
      if (reused) return reused;
    }

    const entity = this.appBuildRepository.create({
      applicationId: params.applicationId,
      provider: params.provider,
      branch: params.branch,
      commitSha: params.commitSha,
      externalRunId: params.externalRunId,
      externalUrl: params.externalUrl,
      buildClusterId: null,
      k8sJobName: null,
      targetClusterId: null,
      gitUrl: null,
      suggestedName: null,
      status: AppBuildStatus.PENDING,
      startedAt: new Date(),
    });
    return this.appBuildRepository.save(entity);
  }

  async generateAndCommitWorkflow(
    appId: string,
    userId: string,
    dto: GenerateWorkflowDto,
  ): Promise<GenerateWorkflowResultDto> {
    this.logger.log(`Generating GitHub Actions workflow for app ${appId}`);

    const app = await this.applicationsRepository.findById(appId);
    if (!app) throw new NotFoundException('Application not found');

    const repository = await this.resolveLinkedRepository(app);

    const webhookToken = uuidv4();
    const baseUrl = this.configService.get<string>('WEBHOOK_BASE_URL') ?? '';
    const fluiWebhookUrl = `${baseUrl}/api/v1/webhooks/github-actions`;

    const defaults = this.workflowGeneratorService.getFrameworkDefaults(
      dto.framework,
    );
    const port = dto.port ?? defaults.port;

    const workflowYaml = this.workflowGeneratorService.generateWorkflow({
      branchName: dto.branch,
      githubUsername: repository.owner,
      repoName: repository.repositoryName,
      fluiAppId: appId,
      fluiWebhookUrl,
      fluiWebhookToken: webhookToken,
      framework: dto.framework,
      packageManager: dto.packageManager,
      nodeVersion: dto.nodeVersion,
      javaVersion: dto.javaVersion,
      dotnetVersion: dto.dotnetVersion,
      backendPollingOnly: this.isBackendPollingOnly(),
    });

    const dockerfile = this.workflowGeneratorService.generateDockerfile({
      framework: dto.framework,
      nodeVersion: dto.nodeVersion,
      javaVersion: dto.javaVersion,
      dotnetVersion: dto.dotnetVersion,
      packageManager: dto.packageManager,
      port,
      appName: dto.appName,
      buildTool: dto.buildTool,
    });

    // The generated workflow logs into GHCR with
    //   password: ${{ secrets.FLUI_GHCR_TOKEN || secrets.GITHUB_TOKEN }}
    // so we always try to populate FLUI_GHCR_TOKEN with the best credential
    // we have (GHCR PAT first, OAuth token second). If neither is available
    // the workflow falls back to GITHUB_TOKEN, which can only push to GHCR
    // when the repository policy permits it.
    await this.saveFluiGhcrSecret(
      userId,
      repository.owner,
      repository.repositoryName,
    );

    const commitResult = await this.githubWorkflowService.commitWorkflowFiles(
      userId,
      repository.owner,
      repository.repositoryName,
      dto.branch,
      workflowYaml,
      dockerfile,
    );

    // Save workflow token and metadata to application. Transition to
    // AWAITING_BUILD here so the background watcher picks it up on its next
    // tick and so the frontend has a distinct "build in progress" state to
    // show — even if fetching the runId below fails transiently.
    await this.applicationsRepository.update(appId, {
      buildPath: 'github-actions',
      webhookToken,
      frameworkConfirmed: dto.framework,
      status: ApplicationStatus.AWAITING_BUILD,
      buildStartedAt: new Date(),
      workflowRunId: null,
      workflowRunUrl: null,
      lastBuildStatus: null,
      lastBuildConclusion: null,
    });

    await this.recordExternalBuildStarted({
      applicationId: appId,
      provider: BuildProvider.GITHUB_ACTIONS,
      branch: dto.branch,
      externalUrl: commitResult.workflowUrl,
      commitSha: commitResult.sha,
      force: dto.force,
    });

    let runId: string | undefined;
    try {
      await this.delay(4000);
      const run = await this.githubWorkflowService.getLatestWorkflowRun(
        userId,
        repository.owner,
        repository.repositoryName,
        dto.branch,
        commitResult.sha,
      );
      if (run) {
        runId = run.runId;
        await this.applicationsRepository.update(appId, {
          workflowRunId: runId,
          workflowRunUrl: run.url,
          lastBuildStatus: run.status,
          lastBuildConclusion: run.conclusion ?? null,
        });
        await this.recordExternalBuildStarted({
          applicationId: appId,
          provider: BuildProvider.GITHUB_ACTIONS,
          branch: dto.branch,
          externalRunId: runId,
          externalUrl: run.url,
          commitSha: run.headSha || commitResult.sha,
          force: dto.force,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Could not fetch initial workflow run ID: ${error.message}`,
      );
    }

    this.logger.log(
      `Workflow committed for app ${appId}. workflowUrl=${commitResult.workflowUrl}`,
    );

    return {
      committed: true,
      workflowUrl: commitResult.workflowUrl,
      runId,
    };
  }

  /**
   * V3: Generates and commits a universal workflow (no Dockerfile, no secret saving).
   * The workflow is identical for all frameworks and relies on the Dockerfile in the repo.
   */
  async generateAndCommitWorkflowV3(
    appId: string,
    userId: string,
    dto: GenerateWorkflowV3Dto,
  ): Promise<GenerateWorkflowResultDto> {
    this.logger.log(`V3: Generating universal workflow for app ${appId}`);

    const app = await this.applicationsRepository.findById(appId);
    if (!app) throw new NotFoundException('Application not found');

    const repository = await this.resolveLinkedRepository(app);

    const webhookToken = uuidv4();
    const baseUrl = this.configService.get<string>('WEBHOOK_BASE_URL') ?? '';
    const fluiWebhookUrl = `${baseUrl}/api/v1/webhooks/github-actions`;

    const workflowFileName = fluiWorkflowFileName(app.slug);
    const workflowYaml = this.workflowGeneratorService.generateWorkflowV3({
      branchName: dto.branch,
      githubOwner: repository.owner,
      repoName: repository.repositoryName,
      appSlug: app.slug,
      fluiAppId: appId,
      fluiWebhookUrl,
      fluiWebhookToken: webhookToken,
      backendPollingOnly: this.isBackendPollingOnly(),
      subPath: dto.subPath,
      dockerfilePath: dto.dockerfilePath,
      buildContext: dto.buildContext,
      workflowFileName,
    });

    // V3 originally relied on `secrets.GITHUB_TOKEN` only, which fails with
    // "Password required" when the repository (or App installation) does not
    // grant `packages: write`. Save FLUI_GHCR_TOKEN preferring the user's
    // GHCR PAT so the workflow's `FLUI_GHCR_TOKEN || GITHUB_TOKEN` fallback
    // can authenticate.
    await this.saveFluiGhcrSecret(
      userId,
      repository.owner,
      repository.repositoryName,
    );

    const commitResult = await this.githubWorkflowService.commitWorkflowOnly(
      userId,
      repository.owner,
      repository.repositoryName,
      dto.branch,
      workflowYaml,
      { workflowFileName, cleanupLegacyForAppId: appId },
    );

    // Persist the monorepo subPath into sourceConfig so the build watcher can
    // compose `{repo}/{subPath}:{sha}` — the exact package this workflow pushes.
    // Without it the watcher rolls out a bare `{repo}:{sha}` that never existed.
    const source = (app.sourceConfig ?? {}) as GitBuildSourceConfig;
    const mergedSourceConfig = {
      ...source,
      type: 'git_build',
      subPath: dto.subPath,
      ...(dto.dockerfilePath ? { dockerfile: dto.dockerfilePath } : {}),
    } as ApplicationSourceConfig;

    await this.applicationsRepository.update(appId, {
      buildPath: 'github-actions',
      webhookToken,
      isFluiManaged: dto.isFluiManaged ?? false,
      status: ApplicationStatus.AWAITING_BUILD,
      sourceConfig: mergedSourceConfig,
      buildStartedAt: new Date(),
      workflowRunId: null,
      workflowRunUrl: null,
      lastBuildStatus: null,
      lastBuildConclusion: null,
    });

    await this.recordExternalBuildStarted({
      applicationId: appId,
      provider: BuildProvider.GITHUB_ACTIONS,
      branch: dto.branch,
      externalUrl: commitResult.workflowUrl,
      commitSha: commitResult.sha,
      force: dto.force,
    });

    let runId: string | undefined;
    try {
      await this.delay(4000);
      const run = await this.githubWorkflowService.getLatestWorkflowRun(
        userId,
        repository.owner,
        repository.repositoryName,
        dto.branch,
        commitResult.sha,
        workflowFileName,
      );
      if (run) {
        runId = run.runId;
        await this.applicationsRepository.update(appId, {
          workflowRunId: runId,
          workflowRunUrl: run.url,
          lastBuildStatus: run.status,
          lastBuildConclusion: run.conclusion ?? null,
        });
        await this.recordExternalBuildStarted({
          applicationId: appId,
          provider: BuildProvider.GITHUB_ACTIONS,
          branch: dto.branch,
          externalRunId: runId,
          externalUrl: run.url,
          commitSha: run.headSha || commitResult.sha,
          force: dto.force,
        });
      }
    } catch (error) {
      this.logger.warn(
        `Could not fetch initial workflow run ID: ${error.message}`,
      );
    }

    this.logger.log(
      `V3 workflow committed for app ${appId}. workflowUrl=${commitResult.workflowUrl}`,
    );

    return {
      committed: true,
      workflowUrl: commitResult.workflowUrl,
      runId,
    };
  }

  async getWorkflowStatus(
    appId: string,
    userId: string,
  ): Promise<WorkflowRunStatus> {
    const app = await this.applicationsRepository.findById(appId);
    if (!app) throw new NotFoundException('Application not found');

    const repository = await this.resolveLinkedRepository(app);

    // Resolve the workflow run status from GitHub.
    let runStatus: WorkflowRunStatus;
    if (app.workflowRunId) {
      runStatus = await this.githubWorkflowService.getWorkflowRunStatus(
        userId,
        repository.owner,
        repository.repositoryName,
        app.workflowRunId,
      );
      // Refresh on-entity cache so canonical GET /applications/:id stays
      // in sync with what we just observed from GitHub.
      await this.applicationsRepository.update(appId, {
        lastBuildStatus: runStatus.status,
        lastBuildConclusion: runStatus.conclusion ?? null,
        workflowRunUrl: runStatus.url || app.workflowRunUrl,
      });
    } else {
      const branch = this.getBuildBranch(app, repository.defaultBranch);
      const activeBuild = await this.appBuildRepository
        .createQueryBuilder('b')
        .where('b.applicationId = :applicationId', { applicationId: appId })
        .andWhere('b.provider = :provider', {
          provider: BuildProvider.GITHUB_ACTIONS,
        })
        .andWhere('b.status NOT IN (:...terminal)', {
          terminal: [
            AppBuildStatus.COMPLETED,
            AppBuildStatus.FAILED,
            AppBuildStatus.CANCELLED,
          ],
        })
        .orderBy('b.createdAt', 'DESC')
        .getOne();
      const run = await this.githubWorkflowService.getLatestWorkflowRun(
        userId,
        repository.owner,
        repository.repositoryName,
        branch,
        activeBuild?.commitSha,
        fluiWorkflowFileName(app.slug),
      );

      if (run) {
        await this.applicationsRepository.update(appId, {
          workflowRunId: run.runId,
          workflowRunUrl: run.url,
          lastBuildStatus: run.status,
          lastBuildConclusion: run.conclusion ?? null,
        });
        runStatus = run;
      } else {
        // Still no run on GitHub: tell the client it's pending instead of
        // 400ing. The frontend can keep polling this endpoint until status
        // flips, and the background watcher will also pick it up.
        runStatus = {
          runId: '',
          status: 'queued',
          conclusion: null,
          url: `https://github.com/${repository.owner}/${repository.repositoryName}/actions`,
          headSha: '',
          runStartedAt: null,
          updatedAt: null,
        };
      }
    }

    // Self-healing: if the app is awaiting build and the run just reached a
    // terminal state, let the watcher reconcile it synchronously. This is
    // what makes the webhook optional — a single frontend poll is enough to
    // advance the app from AWAITING_BUILD to PROVISIONING even when the
    // GitHub Actions `Notify Flui` step couldn't reach our webhook.
    if (
      app.status === ApplicationStatus.AWAITING_BUILD &&
      runStatus.status === 'completed'
    ) {
      try {
        await this.buildWatcher.reconcileBuildStatus(app);
      } catch (err) {
        this.logger.warn(
          `Inline build reconcile failed for app ${appId}: ${err.message}`,
        );
      }
    }

    return runStatus;
  }

  /**
   * Returns the branch the build pipeline should use for this app. Falls back
   * to the repository's default branch if the sourceConfig doesn't carry one.
   */
  private async handleSameCommitTerminalBuild(params: {
    applicationId: string;
    provider: BuildProvider;
    commitSha?: string;
    force?: boolean;
  }): Promise<void> {
    const sameCommitTerminal = await this.appBuildRepository
      .createQueryBuilder('b')
      .where('b.applicationId = :applicationId', {
        applicationId: params.applicationId,
      })
      .andWhere('b.provider = :provider', { provider: params.provider })
      .andWhere('b.commitSha = :commitSha', { commitSha: params.commitSha })
      .andWhere('b.status IN (:...terminal)', {
        terminal: [AppBuildStatus.COMPLETED, AppBuildStatus.FAILED],
      })
      .orderBy('b.createdAt', 'DESC')
      .getOne();
    if (!sameCommitTerminal) return;
    if (!params.force) {
      throw new ConflictException(
        `Build for commit ${params.commitSha.slice(0, 7)} already exists (status=${sameCommitTerminal.status}). Pass force=true to rebuild.`,
      );
    }
    await this.appBuildRepository.update(sameCommitTerminal.id, {
      status: AppBuildStatus.CANCELLED,
      errorMessage: 'Superseded by forced rebuild on the same commit.',
    });
  }

  private async findActiveBuild(params: {
    applicationId: string;
    provider: BuildProvider;
  }): Promise<AppBuildEntity | null> {
    return this.appBuildRepository
      .createQueryBuilder('b')
      .where('b.applicationId = :applicationId', {
        applicationId: params.applicationId,
      })
      .andWhere('b.provider = :provider', { provider: params.provider })
      .andWhere('b.status NOT IN (:...terminal)', {
        terminal: [
          AppBuildStatus.COMPLETED,
          AppBuildStatus.FAILED,
          AppBuildStatus.CANCELLED,
        ],
      })
      .orderBy('b.createdAt', 'DESC')
      .getOne();
  }

  private async reconcileExistingActiveBuild(
    existing: AppBuildEntity,
    params: {
      externalRunId?: string;
      externalUrl?: string;
      commitSha?: string;
    },
  ): Promise<AppBuildEntity | null> {
    const sameCommit =
      !params.commitSha ||
      !existing.commitSha ||
      existing.commitSha === params.commitSha;
    if (!sameCommit) {
      await this.appBuildRepository.update(existing.id, {
        status: AppBuildStatus.CANCELLED,
        errorMessage:
          'Superseded by a new build triggered for a different commit.',
        completedAt: new Date(),
      });
      return null;
    }
    const patch: Partial<AppBuildEntity> = {};
    if (
      params.externalRunId &&
      existing.externalRunId !== params.externalRunId
    ) {
      patch.externalRunId = params.externalRunId;
    }
    if (params.externalUrl && existing.externalUrl !== params.externalUrl) {
      patch.externalUrl = params.externalUrl;
    }
    if (params.commitSha && existing.commitSha !== params.commitSha) {
      patch.commitSha = params.commitSha;
    }
    if (Object.keys(patch).length > 0) {
      await this.appBuildRepository.update(existing.id, patch);
      Object.assign(existing, patch);
    }
    return existing;
  }

  private getBuildBranch(
    app: { sourceConfig: unknown },
    fallback: string,
  ): string {
    const sourceConfig = app.sourceConfig as
      | { type?: string; branch?: string }
      | undefined;
    return sourceConfig?.branch || fallback || 'main';
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * When `BACKEND_POLLING_ONLY=true` is set in the environment, the generated
   * GitHub Actions workflow skips its "Notify Flui" curl steps entirely and
   * we rely exclusively on the backend build watcher to discover completion
   * by polling the GitHub API. Default false — both webhook and polling are
   * active, the webhook wins when it can reach us, the poller picks up the
   * slack when it can't.
   */
  private isBackendPollingOnly(): boolean {
    const raw = this.configService.get<string>('BACKEND_POLLING_ONLY');
    return raw === 'true' || raw === '1';
  }

  /**
   * Resolves the linked Repository entity from an application's sourceConfig.
   * Throws a clear `BadRequestException` if `repositoryId` is missing or is not
   * a valid UUID (e.g. the caller mistakenly stored a GitHub `owner/repo`
   * full_name there). This avoids the underlying Postgres 500 from
   * `findById('owner/repo')` and gives the client an actionable message.
   */
  private async resolveLinkedRepository(app: {
    id: string;
    sourceConfig: unknown;
  }) {
    const sourceConfig = app.sourceConfig as
      | { type?: string; repositoryId?: string }
      | undefined;
    const repositoryId =
      sourceConfig?.type === 'git_build'
        ? sourceConfig.repositoryId
        : undefined;

    if (!repositoryId) {
      throw new BadRequestException(
        'Application has no linked repository. Link a repository before generating a workflow.',
      );
    }

    if (!uuidValidate(repositoryId)) {
      throw new BadRequestException(
        `Application ${app.id} has an invalid sourceConfig.repositoryId ("${repositoryId}"). ` +
          'It must be the UUID of a Flui Repository entity, not a GitHub "owner/repo" full_name. ' +
          'Register the repository first via POST /repositories and use the returned id.',
      );
    }

    const repository = await this.repositoriesRepository.findById(repositoryId);
    if (!repository) {
      throw new NotFoundException(
        `Linked repository ${repositoryId} not found. It may have been deleted.`,
      );
    }
    return repository;
  }
}
