import { Injectable, Inject, forwardRef, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { RepositoriesRepository } from '../../repositories/repositories/repositories.repository';
import {
  GitHubWorkflowService,
  WorkflowRunStatus,
  fluiWorkflowFileName,
} from '../../repositories/services/github-workflow.service';
import { ApplicationDeployService } from './application-deploy.service';
import { ApplicationEventsGateway } from '../gateway/application-events.gateway';
import { ImageRegistryService } from '../../image-registry/services/image-registry.service';
import { ApplicationEntity } from '../entities/application.entity';
import { GitBuildSourceConfig } from '../interfaces/source-config.interface';
import { composeGhcrImageRef } from '../utils/image-ref.util';
import { ApplicationStatus } from '../enums/application-status.enum';
import {
  InfrastructureOperationEntity,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { AppBuildEntity } from '../../app-builds/entities/app-build.entity';
import { AppBuildStatus } from '../../app-builds/enums/app-build-status.enum';
import { BuildProvider } from '../../app-builds/enums/build-provider.enum';

/**
 * Hard cap on how long an app may stay in AWAITING_BUILD before we mark it
 * FAILED. Covers stuck / lost workflows and protects against zombie apps.
 */
export const BUILD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Core reconciler for apps in AWAITING_BUILD state. Owns the GitHub-polling
 * logic and the transition into PROVISIONING (or FAILED) once a build result
 * is known.
 *
 * This service is the single source of truth for "is the build done?" —
 * all three entry points delegate here:
 *   1. Background Bull repeat job (application-build-watch queue)
 *   2. Frontend-driven polling via GET /applications/:id/workflow-status
 *   3. Legacy GitHub Actions webhook (fast path, when reachable)
 *
 * The image reference is fully deterministic from (owner, slug, commit sha),
 * which is what makes the webhook optional: given just the GitHub run we can
 * compute exactly the imageRef the build pushed and trigger the deploy
 * ourselves, no notification needed.
 */
@Injectable()
export class ApplicationBuildWatcherService {
  private readonly logger = new Logger(ApplicationBuildWatcherService.name);

  constructor(
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly repositoriesRepository: RepositoriesRepository,
    private readonly githubWorkflowService: GitHubWorkflowService,
    private readonly applicationDeployService: ApplicationDeployService,
    private readonly eventsGateway: ApplicationEventsGateway,
    @Inject(forwardRef(() => ImageRegistryService))
    private readonly imageRegistryService: ImageRegistryService,
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    @InjectRepository(AppBuildEntity)
    private readonly appBuildRepository: Repository<AppBuildEntity>,
  ) {}

  /**
   * Returns the active (non-terminal) AppBuild row for this app on the
   * GitHub Actions provider, preferring an exact match on the workflow run id
   * when available. Returns null if no active row exists — callers should
   * gracefully no-op in that case (older apps created before the unified
   * Build model won't have a row).
   */
  private async findActiveGithubBuild(
    applicationId: string,
    runId?: string,
  ): Promise<AppBuildEntity | null> {
    if (runId) {
      const byRun = await this.appBuildRepository.findOne({
        where: {
          applicationId,
          provider: BuildProvider.GITHUB_ACTIONS,
          externalRunId: runId,
        },
        order: { createdAt: 'DESC' },
      });
      if (byRun) return byRun;
    }
    return this.appBuildRepository
      .createQueryBuilder('b')
      .where('b.applicationId = :applicationId', { applicationId })
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
  }

  /**
   * Reconcile all apps currently stuck in AWAITING_BUILD. Called on every
   * watcher tick; query is a single indexed lookup, so running even every
   * 30 seconds is cheap on a cold cluster.
   */
  async reconcileAll(): Promise<void> {
    const apps = await this.applicationsRepository.findAwaitingBuild();
    if (apps.length > 0) {
      this.logger.log(
        `[build-watch] tick: reconciling ${apps.length} app(s) in AWAITING_BUILD`,
      );
      for (const app of apps) {
        try {
          await this.reconcileBuildStatus(app);
        } catch (err) {
          this.logger.error(
            `[build-watch] Reconcile failed for app ${app.id} (${app.name}): ${err.message}`,
            err.stack,
          );
        }
      }
    }

    const liveApps = await this.applicationsRepository.findLiveGitBuildApps();
    if (liveApps.length > 0) {
      this.logger.debug(
        `[build-watch] tick: scanning ${liveApps.length} live app(s) for new commits`,
      );
      for (const app of liveApps) {
        try {
          await this.discoverAndReconcileLiveBuild(app);
        } catch (err) {
          this.logger.error(
            `[build-watch] Live discover failed for app ${app.id} (${app.name}): ${err.message}`,
            err.stack,
          );
        }
      }
    }

    if (apps.length === 0 && liveApps.length === 0) {
      this.logger.debug('[build-watch] tick: no apps to scan');
    }
  }

  /**
   * Discovers a new GHA run on a live app's branch and either creates a fresh
   * AppBuild row (if the run is new) or syncs the existing one. When the run
   * has already concluded with success, idempotently triggers a deploy with
   * the new imageRef — the deploy service has its own dedup check.
   */
  private async discoverAndReconcileLiveBuild(
    app: ApplicationEntity,
  ): Promise<void> {
    if (!app.userId) return;

    const sourceConfig = app.sourceConfig as
      | { type?: string; repositoryId?: string; branch?: string }
      | undefined;
    const repositoryId = sourceConfig?.repositoryId;
    if (!repositoryId) return;

    const repository = await this.repositoriesRepository.findById(repositoryId);
    if (!repository) return;

    const branch = sourceConfig?.branch || repository.defaultBranch || 'main';

    let run: WorkflowRunStatus | null = null;
    try {
      run = await this.githubWorkflowService.getLatestWorkflowRun(
        app.userId,
        repository.owner,
        repository.repositoryName,
        branch,
        undefined,
        fluiWorkflowFileName(app.slug),
      );
    } catch (err) {
      this.logger.warn(
        `[build-watch] live discover GitHub query failed for app ${app.id}: ${err.message}`,
      );
      return;
    }
    if (!run) return;

    const latestBuild = await this.appBuildRepository
      .createQueryBuilder('b')
      .where('b.applicationId = :applicationId', { applicationId: app.id })
      .andWhere('b.provider = :provider', {
        provider: BuildProvider.GITHUB_ACTIONS,
      })
      .orderBy('b.createdAt', 'DESC')
      .getOne();

    const isKnownRun =
      latestBuild?.externalRunId === run.runId ||
      (run.headSha && latestBuild?.commitSha === run.headSha);

    if (!isKnownRun) {
      await this.recordDiscoveredRun(app, run, branch);
    } else if (latestBuild) {
      await this.syncActiveBuildFromRun(app.id, run);
    }

    if (
      run.status === 'completed' &&
      run.conclusion === 'success' &&
      run.headSha
    ) {
      const shortSha = run.headSha.slice(0, 7);
      const imageRef = this.composeImageRef(app, repository, shortSha);

      if (app.imageRef === imageRef) {
        return;
      }

      const recentOp = await this.operationRepository.findOne({
        where: {
          resourceId: app.id,
          operationType: OperationType.DEPLOY_APPLICATION,
        },
        order: { createdAt: 'DESC' },
      });
      if (recentOp && recentOp.metadata?.imageRef === imageRef) {
        return;
      }

      await this.markBuildCompleted(app.id, run, imageRef);

      try {
        await this.imageRegistryService.recordImage({
          appId: app.id,
          imageRef,
          commitSha: run.headSha,
          branch,
        });
      } catch (err) {
        this.logger.warn(
          `[build-watch] live recordImage failed for ${app.id}: ${err.message}`,
        );
      }

      this.eventsGateway.emitBuildCompleted(app.id, {
        appId: app.id,
        buildId: run.runId,
        imageRef,
        duration: 0,
        timestamp: new Date(),
      });

      this.logger.log(
        `[build-watch] live build success for ${app.name} (${app.id}), triggering deploy with ${imageRef}`,
      );
      await this.applicationDeployService.triggerDeployWithImage(
        app.id,
        imageRef,
        app.userId,
      );
    } else if (run.status === 'completed') {
      await this.markBuildEntityFailed(
        app.id,
        run.conclusion === 'failure' || run.conclusion === 'cancelled'
          ? `GitHub Actions build ${run.conclusion}: ${run.url}`
          : `GitHub Actions build concluded as "${run.conclusion}": ${run.url}`,
        run,
      );
    }
  }

  /**
   * Reconcile a single application. Queries GitHub for the latest workflow
   * run state, then:
   *   - still running → enforce timeout, otherwise noop
   *   - success       → compute imageRef, idempotently trigger deploy
   *   - failure       → mark app FAILED with the GitHub URL
   *
   * Idempotency: before triggering a deploy we look up the latest
   * DEPLOY_APPLICATION operation for this app and short-circuit if its
   * metadata.imageRef already matches. This protects against:
   *   - webhook + poller racing on the same run
   *   - two concurrent watcher ticks on the same app
   *   - frontend poll landing mid-deploy
   */
  async reconcileBuildStatus(app: ApplicationEntity): Promise<void> {
    // Sanity guard — callers may pass a stale snapshot.
    if (app.status !== ApplicationStatus.AWAITING_BUILD) {
      return;
    }

    // Hard timeout: independent of GitHub's view, if we've been waiting too
    // long we bail out with a clean error instead of lingering forever.
    if (this.hasTimedOut(app)) {
      await this.markBuildFailed(
        app,
        `Build did not complete within ${BUILD_TIMEOUT_MS / 60000} minutes`,
      );
      return;
    }

    if (!app.userId) {
      // No owner → we cannot authenticate to GitHub to read the run status.
      // This should not happen in practice (git_build apps always have a
      // userId) but we handle it defensively.
      this.logger.warn(
        `[build-watch] App ${app.id} has no userId, cannot poll GitHub`,
      );
      return;
    }

    const sourceConfig = app.sourceConfig as
      | { type?: string; repositoryId?: string; branch?: string }
      | undefined;
    const repositoryId = sourceConfig?.repositoryId;
    if (!repositoryId) {
      this.logger.warn(
        `[build-watch] App ${app.id} has no sourceConfig.repositoryId`,
      );
      return;
    }

    const repository = await this.repositoriesRepository.findById(repositoryId);
    if (!repository) {
      await this.markBuildFailed(
        app,
        `Linked repository ${repositoryId} was deleted before the build completed`,
      );
      return;
    }

    // Resolve the workflow run. If we already saved a runId, fetch it by id;
    // otherwise fall back to "latest run on branch" (covers the edge case
    // where the run was queued but not yet visible when we committed).
    let run: WorkflowRunStatus | null;
    const branch = sourceConfig?.branch || repository.defaultBranch || 'main';
    try {
      if (app.workflowRunId) {
        run = await this.githubWorkflowService.getWorkflowRunStatus(
          app.userId,
          repository.owner,
          repository.repositoryName,
          app.workflowRunId,
        );
        this.logger.log(
          `[build-watch] app=${app.name} run=${app.workflowRunId} status=${run.status} conclusion=${run.conclusion ?? 'null'}`,
        );
      } else {
        const activeBuild = await this.findActiveGithubBuild(app.id);
        run = await this.githubWorkflowService.getLatestWorkflowRun(
          app.userId,
          repository.owner,
          repository.repositoryName,
          branch,
          activeBuild?.commitSha,
          fluiWorkflowFileName(app.slug),
        );
        if (run?.runId) {
          this.logger.log(
            `[build-watch] app=${app.name} discovered run=${run.runId} status=${run.status} (no prior workflowRunId) — persisting`,
          );
          try {
            await this.applicationsRepository.update(app.id, {
              workflowRunId: run.runId,
              workflowRunUrl: run.url,
            });
          } catch (updateErr) {
            this.logger.error(
              `[build-watch] Failed to persist discovered runId for app ${app.id}: ${updateErr.message}`,
              updateErr.stack,
            );
          }
        } else {
          this.logger.warn(
            `[build-watch] app=${app.name} has no workflowRunId and getLatestWorkflowRun returned null on branch '${branch}' (${repository.owner}/${repository.repositoryName}). Next tick will retry.`,
          );
        }
      }
    } catch (err) {
      // Transient GitHub errors (rate limit, 5xx, network blip) are not
      // terminal — next tick will retry. Elevated to warn so we see them.
      this.logger.warn(
        `[build-watch] GitHub query failed for app ${app.id} (${app.name}): ${err.message}`,
      );
      return;
    }

    // Refresh the on-entity cache so GET /applications/:id reflects the
    // latest build state without requiring the frontend to hit the GitHub
    // API itself. This is the backbone of option C — one canonical endpoint.
    if (run) {
      try {
        await this.applicationsRepository.update(app.id, {
          lastBuildStatus: run.status,
          lastBuildConclusion: run.conclusion ?? null,
          // Keep URL fresh in case the first persist failed or the value rotated
          workflowRunUrl: run.url || app.workflowRunUrl,
        });
        await this.syncActiveBuildFromRun(app.id, run);
      } catch (updateErr) {
        // A failure here typically means the new columns are missing from
        // the DB schema (backend not restarted after the migration). Log
        // loudly so it's not mistaken for a silent no-op.
        this.logger.error(
          `[build-watch] Failed to update build cache for app ${app.id}: ${updateErr.message}. ` +
            `If you see "column does not exist" errors, restart the API so TypeORM syncs the new schema.`,
          updateErr.stack,
        );
      }
    }

    if (run?.status !== 'completed') {
      // Build still in progress (or run not visible yet) — wait for the
      // next tick. Timeout check at the top of this method catches stalls.
      return;
    }

    if (run.conclusion === 'failure' || run.conclusion === 'cancelled') {
      await this.markBuildFailed(
        app,
        `GitHub Actions build ${run.conclusion}: ${run.url}`,
        run,
      );
      return;
    }

    if (run.conclusion !== 'success') {
      // 'skipped', 'neutral', 'timed_out', etc. — treat as failure for now.
      await this.markBuildFailed(
        app,
        `GitHub Actions build concluded as "${run.conclusion}": ${run.url}`,
        run,
      );
      return;
    }

    // Success path: compute deterministic imageRef and trigger the deploy.
    if (!run.headSha) {
      this.logger.warn(
        `[build-watch] Workflow ${run.runId} for app ${app.id} has no head_sha; skipping`,
      );
      return;
    }

    const shortSha = run.headSha.slice(0, 7);
    const imageRef = this.composeImageRef(app, repository, shortSha);

    // Idempotency check: has a deploy already been queued for this exact image?
    const existingOp = await this.operationRepository.findOne({
      where: {
        resourceId: app.id,
        operationType: OperationType.DEPLOY_APPLICATION,
      },
      order: { createdAt: 'DESC' },
    });
    if (existingOp && existingOp.metadata?.imageRef === imageRef) {
      this.logger.debug(
        `[build-watch] App ${app.id} already has deploy op ${existingOp.id} for imageRef ${imageRef}; skipping`,
      );
      return;
    }

    this.logger.log(
      `[build-watch] Build success for app ${app.name} (${app.id}), triggering deploy with ${imageRef}`,
    );

    this.eventsGateway.emitBuildCompleted(app.id, {
      appId: app.id,
      buildId: run.runId,
      imageRef,
      duration: 0,
      timestamp: new Date(),
    });

    await this.markBuildCompleted(app.id, run, imageRef);

    try {
      await this.imageRegistryService.recordImage({
        appId: app.id,
        imageRef,
        commitSha: run.headSha,
        branch,
      });
    } catch (err) {
      this.logger.warn(
        `[build-watch] Failed to record image for ${app.id}: ${err.message}`,
      );
    }

    await this.applicationDeployService.triggerDeployWithImage(
      app.id,
      imageRef,
      app.userId,
    );
  }

  /**
   * Reconciles a specific AppBuild row against GitHub Actions, regardless of
   * the parent app's status. Used by the manual refresh endpoint so the row
   * can transition past PENDING even when the app has already moved out of
   * AWAITING_BUILD (e.g. a previous deploy already settled).
   *
   * Only the build row is mutated. A new deploy is triggered only when the
   * app is still in AWAITING_BUILD AND the run concluded with success — that
   * preserves the existing watcher contract for the deploy side.
   */
  async reconcileBuildRow(build: AppBuildEntity): Promise<AppBuildEntity> {
    if (build.provider !== BuildProvider.GITHUB_ACTIONS) {
      return build;
    }
    if (!build.applicationId) {
      return build;
    }
    const terminal: AppBuildStatus[] = [
      AppBuildStatus.COMPLETED,
      AppBuildStatus.FAILED,
      AppBuildStatus.CANCELLED,
    ];
    if (terminal.includes(build.status)) {
      return build;
    }

    const app = await this.applicationsRepository.findById(build.applicationId);
    if (!app?.userId) return build;

    const sourceConfig = app.sourceConfig as
      | { type?: string; repositoryId?: string; branch?: string }
      | undefined;
    const repositoryId = sourceConfig?.repositoryId;
    if (!repositoryId) return build;

    const repository = await this.repositoriesRepository.findById(repositoryId);
    if (!repository) return build;

    const branch =
      build.branch ||
      sourceConfig?.branch ||
      repository.defaultBranch ||
      'main';

    let run: WorkflowRunStatus | null = null;
    try {
      if (build.externalRunId) {
        run = await this.githubWorkflowService.getWorkflowRunStatus(
          app.userId,
          repository.owner,
          repository.repositoryName,
          build.externalRunId,
        );
      } else {
        run = await this.githubWorkflowService.getLatestWorkflowRun(
          app.userId,
          repository.owner,
          repository.repositoryName,
          branch,
          build.commitSha,
          fluiWorkflowFileName(app.slug),
        );
      }
    } catch (err) {
      this.logger.warn(
        `[refresh] GitHub query failed for build ${build.id}: ${err.message}`,
      );
      return build;
    }

    if (!run) return build;

    await this.syncActiveBuildFromRun(app.id, run);

    if (run.status !== 'completed') {
      const refreshed = await this.appBuildRepository.findOne({
        where: { id: build.id },
      });
      return refreshed ?? build;
    }

    if (run.conclusion === 'success' && run.headSha) {
      const shortSha = run.headSha.slice(0, 7);
      const imageRef = this.composeImageRef(app, repository, shortSha);
      await this.markBuildCompleted(app.id, run, imageRef);

      if (app.status === ApplicationStatus.AWAITING_BUILD) {
        try {
          await this.reconcileBuildStatus(app);
        } catch (err) {
          this.logger.warn(
            `[refresh] Inline reconcile failed for app ${app.id}: ${err.message}`,
          );
        }
      }
    } else {
      const reason =
        run.conclusion === 'failure' || run.conclusion === 'cancelled'
          ? `GitHub Actions build ${run.conclusion}: ${run.url}`
          : `GitHub Actions build concluded as "${run.conclusion}": ${run.url}`;
      await this.markBuildEntityFailed(app.id, reason, run);
    }

    const refreshed = await this.appBuildRepository.findOne({
      where: { id: build.id },
    });
    return refreshed ?? build;
  }

  /**
   * Compose the rollout imageRef for a completed build. Mirrors the build path:
   * monorepo apps push to `ghcr.io/{owner}/{repo}/{subPath}:{sha}`, single-app
   * repos to `ghcr.io/{owner}/{repo}:{sha}`. Reading subPath from sourceConfig
   * keeps the watcher in sync with what the generated workflow actually pushed —
   * without it the watcher rolls a non-existent `{repo}:{sha}` → ImagePullBackOff.
   */
  private composeImageRef(
    app: ApplicationEntity,
    repository: { owner: string; repositoryName: string },
    shortSha: string,
  ): string {
    const cfg = app.sourceConfig as GitBuildSourceConfig | undefined;
    return composeGhcrImageRef({
      owner: repository.owner,
      repoName: repository.repositoryName,
      tag: shortSha,
      subPath: cfg?.type === 'git_build' ? cfg.subPath : undefined,
    });
  }

  private hasTimedOut(app: ApplicationEntity): boolean {
    if (!app.buildStartedAt) return false;
    return Date.now() - app.buildStartedAt.getTime() > BUILD_TIMEOUT_MS;
  }

  private async recordDiscoveredRun(
    app: ApplicationEntity,
    run: WorkflowRunStatus,
    branch: string,
  ): Promise<void> {
    this.logger.log(
      `[build-watch] discovered new run ${run.runId} for live app ${app.name} (commit=${run.headSha?.slice(0, 7)})`,
    );
    const initialStatus = this.runToInitialStatus(run);
    const newBuild = this.appBuildRepository.create({
      applicationId: app.id,
      provider: BuildProvider.GITHUB_ACTIONS,
      branch,
      commitSha: run.headSha || undefined,
      externalRunId: run.runId,
      externalUrl: run.url,
      buildClusterId: null,
      k8sJobName: null,
      targetClusterId: null,
      gitUrl: null,
      suggestedName: null,
      status: initialStatus,
      startedAt: run.runStartedAt ?? new Date(),
      completedAt:
        run.status === 'completed' ? (run.updatedAt ?? new Date()) : undefined,
    });
    await this.appBuildRepository.save(newBuild);
  }

  private runToInitialStatus(run: WorkflowRunStatus): AppBuildStatus {
    if (run.status === 'completed') {
      return run.conclusion === 'success'
        ? AppBuildStatus.COMPLETED
        : AppBuildStatus.FAILED;
    }
    if (run.status === 'in_progress') return AppBuildStatus.BUILDING;
    return AppBuildStatus.PENDING;
  }

  private async syncActiveBuildFromRun(
    applicationId: string,
    run: WorkflowRunStatus,
  ): Promise<void> {
    const build = await this.findActiveGithubBuild(applicationId, run.runId);
    if (!build) return;

    const patch: Partial<AppBuildEntity> = {};
    if (run.runId && build.externalRunId !== run.runId) {
      patch.externalRunId = run.runId;
    }
    if (run.url && build.externalUrl !== run.url) {
      patch.externalUrl = run.url;
    }
    if (run.headSha && build.commitSha !== run.headSha) {
      patch.commitSha = run.headSha;
    }
    if (
      run.status === 'in_progress' &&
      build.status === AppBuildStatus.PENDING
    ) {
      patch.status = AppBuildStatus.BUILDING;
    }
    if (
      run.runStartedAt &&
      build.startedAt?.getTime() !== run.runStartedAt.getTime()
    ) {
      patch.startedAt = run.runStartedAt;
    }
    if (Object.keys(patch).length > 0) {
      await this.appBuildRepository.update(build.id, patch);
    }
  }

  private async markBuildCompleted(
    applicationId: string,
    run: WorkflowRunStatus,
    imageRef: string,
  ): Promise<void> {
    const build = await this.findActiveGithubBuild(applicationId, run.runId);
    if (!build) return;
    await this.appBuildRepository.update(build.id, {
      status: AppBuildStatus.COMPLETED,
      imageRef,
      commitSha: run.headSha || build.commitSha,
      externalRunId: run.runId || build.externalRunId,
      externalUrl: run.url || build.externalUrl,
      startedAt: run.runStartedAt ?? build.startedAt,
      completedAt: run.updatedAt ?? new Date(),
    });
  }

  private async markBuildEntityFailed(
    applicationId: string,
    reason: string,
    run?: WorkflowRunStatus,
  ): Promise<void> {
    const build = await this.findActiveGithubBuild(applicationId, run?.runId);
    if (!build) return;
    await this.appBuildRepository.update(build.id, {
      status: AppBuildStatus.FAILED,
      errorMessage: reason,
      externalRunId: run?.runId || build.externalRunId,
      externalUrl: run?.url || build.externalUrl,
      commitSha: run?.headSha || build.commitSha,
      startedAt: run?.runStartedAt ?? build.startedAt,
      completedAt: run?.updatedAt ?? new Date(),
    });
  }

  private async markBuildFailed(
    app: ApplicationEntity,
    reason: string,
    run?: WorkflowRunStatus,
  ): Promise<void> {
    this.logger.warn(
      `[build-watch] Marking app ${app.name} (${app.id}) as FAILED: ${reason}`,
    );
    await this.applicationsRepository.update(app.id, {
      status: ApplicationStatus.FAILED,
      reconciliationError: reason,
    });

    await this.markBuildEntityFailed(app.id, reason, run);

    this.eventsGateway.emitBuildFailed(app.id, {
      appId: app.id,
      buildId: run?.runId ?? 'unknown',
      operationId: 'build-watch',
      error: reason,
      timestamp: new Date(),
    });
  }
}
