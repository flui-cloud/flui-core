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
  WorkflowDelivery,
  WorkflowRunStatus,
  fluiWorkflowFileName,
} from '../../repositories/services/github-workflow.service';
import {
  WorkflowConsent,
  buildWorkflowConsent,
  resolveWorkflowDelivery,
} from '../../repositories/services/workflow-consent';
import { GitHubTokenResolverService } from '../../repositories/services/github-token-resolver.service';
import {
  FLUI_WEBHOOK_SECRET,
  WorkflowGeneratorService,
} from '../../repositories/services/workflow-generator.service';
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
import {
  BuildExpectation,
  durationsOf,
  noBuildExpectation,
  summariseBuildDurations,
} from '../../app-builds/services/build-expectation';
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
  /**
   * Where the commit lands. Ignored for a sandbox guest, who always gets a
   * pull request — see resolveWorkflowDelivery.
   */
  delivery?: WorkflowDelivery;
}

export interface GenerateWorkflowResultDto {
  committed: boolean;
  workflowUrl: string;
  runId?: string;
  /** Set when the workflow was proposed instead of pushed. */
  pullRequestUrl?: string;
  /**
   * Whether anything is building right now. False after a pull request: the
   * branch has not moved, so no run exists and the application must not be
   * shown as awaiting one.
   */
  buildStarted: boolean;
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

  /**
   * Puts the webhook credential into the repository's secrets, before the file
   * that reads it exists.
   *
   * Unlike the GHCR secret this one is not best-effort. That header is a deploy
   * trigger, so it cannot travel as text in the committed file; and a workflow
   * committed without the secret it reads is a file we left in somebody else's
   * repository that cannot work. If the secret cannot be written, the workflow
   * is not committed at all.
   */
  private async saveWebhookSecret(
    userId: string,
    owner: string,
    repo: string,
    token: string,
  ): Promise<void> {
    try {
      await this.githubWorkflowService.saveRepoSecret(
        userId,
        owner,
        repo,
        FLUI_WEBHOOK_SECRET,
        token,
      );
    } catch (err) {
      this.logger.error(
        `Failed to save ${FLUI_WEBHOOK_SECRET} on ${owner}/${repo}: ${err.message}`,
        err.stack,
      );
      throw new BadRequestException(
        `Flui could not write the ${FLUI_WEBHOOK_SECRET} repository secret to ${owner}/${repo}, so it did not commit the workflow. The workflow reads that secret to report the build back, and Flui will not leave a file that cannot work in your repository. Check that the GitHub connection is allowed to manage this repository's secrets, then try again.`,
      );
    }
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

    // The secret must exist before the workflow that reads it can run, and the
    // commit is what makes it runnable — so this comes first, and a failure
    // here means no commit at all.
    if (!this.isBackendPollingOnly()) {
      await this.saveWebhookSecret(
        userId,
        repository.owner,
        repository.repositoryName,
        webhookToken,
      );
    }

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
      buildStarted: true,
    };
  }

  /**
   * Everything the V3 commit would write, rendered before writing any of it.
   *
   * Reads nothing the commit does not read and writes nothing at all, so the
   * screen it feeds can be opened as many times as somebody wants to reread it.
   * The workflow body is the real generator's output — a preview produced by a
   * second code path would be a description of the commit rather than the
   * commit itself, and would drift the first time one of the two changed.
   */
  async previewWorkflowV3(
    appId: string,
    userId: string,
    dto: GenerateWorkflowV3Dto,
    isSandboxGuest = false,
  ): Promise<WorkflowConsent> {
    const app = await this.applicationsRepository.findById(appId);
    if (!app) throw new NotFoundException('Application not found');

    const repository = await this.resolveLinkedRepository(app);
    const workflowFileName = fluiWorkflowFileName(app.slug);
    const backendPollingOnly = this.isBackendPollingOnly();

    const workflowYaml = this.workflowGeneratorService.generateWorkflowV3(
      this.workflowParamsV3(app, appId, repository, dto, workflowFileName),
    );

    return buildWorkflowConsent({
      owner: repository.owner,
      repo: repository.repositoryName,
      branch: dto.branch,
      delivery: resolveWorkflowDelivery({
        requested: dto.delivery,
        isSandboxGuest,
      }),
      workflowPath: `.github/workflows/${workflowFileName}`,
      workflowYaml,
      // With backend polling on the generated workflow has no Notify steps, so
      // no secret is written and naming one would point at a line the reader
      // cannot find.
      webhookSecretName: backendPollingOnly ? null : FLUI_WEBHOOK_SECRET,
      writesGhcrSecret: true,
      ghcrSecretName: 'FLUI_GHCR_TOKEN',
    });
  }

  /**
   * The single description of a V3 workflow, shared by the preview and the
   * commit. Only the webhook token differs between them.
   */
  private workflowParamsV3(
    app: { slug: string },
    appId: string,
    repository: { owner: string; repositoryName: string },
    dto: GenerateWorkflowV3Dto,
    workflowFileName: string,
  ) {
    const baseUrl = this.configService.get<string>('WEBHOOK_BASE_URL') ?? '';
    return {
      branchName: dto.branch,
      githubOwner: repository.owner,
      repoName: repository.repositoryName,
      appSlug: app.slug,
      fluiAppId: appId,
      fluiWebhookUrl: `${baseUrl}/api/v1/webhooks/github-actions`,
      backendPollingOnly: this.isBackendPollingOnly(),
      subPath: dto.subPath,
      dockerfilePath: dto.dockerfilePath,
      buildContext: dto.buildContext,
      workflowFileName,
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
    isSandboxGuest = false,
  ): Promise<GenerateWorkflowResultDto> {
    this.logger.log(`V3: Generating universal workflow for app ${appId}`);

    const app = await this.applicationsRepository.findById(appId);
    if (!app) throw new NotFoundException('Application not found');

    const repository = await this.resolveLinkedRepository(app);

    const webhookToken = uuidv4();
    const workflowFileName = fluiWorkflowFileName(app.slug);
    const delivery = resolveWorkflowDelivery({
      requested: dto.delivery,
      isSandboxGuest,
    });
    const workflowYaml = this.workflowGeneratorService.generateWorkflowV3(
      this.workflowParamsV3(app, appId, repository, dto, workflowFileName),
    );

    // Same ordering as V1: the credential the workflow reads lands before the
    // workflow does, and if it cannot land nothing is committed.
    if (!this.isBackendPollingOnly()) {
      await this.saveWebhookSecret(
        userId,
        repository.owner,
        repository.repositoryName,
        webhookToken,
      );
    }

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
      { workflowFileName, cleanupLegacyForAppId: appId, delivery },
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

    // A pull request moves no branch, so nothing is queued and nothing is
    // building. Marking the application AWAITING_BUILD here would put a spinner
    // on a screen for a run that will not exist until somebody merges — the
    // build clock would start counting an event that has not happened.
    const proposed = commitResult.pullRequestUrl !== undefined;

    await this.applicationsRepository.update(appId, {
      buildPath: 'github-actions',
      webhookToken,
      isFluiManaged: dto.isFluiManaged ?? false,
      sourceConfig: mergedSourceConfig,
      ...(proposed
        ? {}
        : {
            status: ApplicationStatus.AWAITING_BUILD,
            buildStartedAt: new Date(),
          }),
      workflowRunId: null,
      workflowRunUrl: null,
      lastBuildStatus: null,
      lastBuildConclusion: null,
    });

    if (proposed) {
      this.logger.log(
        `V3 workflow proposed for app ${appId}. pullRequest=${commitResult.pullRequestUrl}`,
      );
      return {
        committed: true,
        workflowUrl: commitResult.workflowUrl,
        pullRequestUrl: commitResult.pullRequestUrl,
        buildStarted: false,
      };
    }

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
      buildStarted: true,
    };
  }

  /**
   * How long a build here has taken, measured.
   *
   * Prefers this application's own finished builds; falls back to the caller's
   * other applications, which is the widest sample that still contains nothing
   * but their own work; and when there is neither, says so and gives no number.
   */
  async getBuildExpectation(
    appId: string,
    userId: string,
  ): Promise<BuildExpectation> {
    const own = await this.appBuildRepository.find({
      where: { applicationId: appId, status: AppBuildStatus.COMPLETED },
      order: { completedAt: 'DESC' },
      take: 10,
      select: ['startedAt', 'completedAt'],
    });
    const ownDurations = durationsOf(own);
    if (ownDurations.length > 0) {
      return summariseBuildDurations(ownDurations, 'this-application');
    }

    const mine = await this.appBuildRepository
      .createQueryBuilder('build')
      .select(['build.startedAt', 'build.completedAt'])
      .where('build.status = :status', { status: AppBuildStatus.COMPLETED })
      .andWhere(
        'build.applicationId IN (SELECT id FROM applications WHERE "userId" = :userId)',
        { userId },
      )
      .orderBy('build.completedAt', 'DESC')
      .limit(10)
      .getMany();
    const mineDurations = durationsOf(mine);
    if (mineDurations.length > 0) {
      return summariseBuildDurations(mineDurations, 'your-recent-builds');
    }

    return noBuildExpectation();
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
