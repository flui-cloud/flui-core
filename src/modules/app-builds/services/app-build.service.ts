import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import {
  BuildNamespaceResourcesResponseDto,
  BuildNamespaceCleanupResultDto,
  CleanupBuildNamespaceDto,
  QueuedBuildInfoDto,
} from '../dto/build-namespace.dto';
import { BuildCheckResponseDto } from '../dto/build-check-response.dto';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { InjectQueue } from '@nestjs/bull';
import { Queue } from 'bull';
import { Octokit } from '@octokit/rest';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { AppBuildsRepository } from '../repositories/app-builds.repository';
import { AppBuildEntity } from '../entities/app-build.entity';
import { AppBuildStatus } from '../enums/app-build-status.enum';
import { BuildProvider } from '../enums/build-provider.enum';
import { ApplicationBuildWatcherService } from '../../applications/services/application-build-watcher.service';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationSourceType } from '../../applications/enums/application-source-type.enum';
import { ApplicationStatus } from '../../applications/enums/application-status.enum';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import {
  RepositoryEntity,
  GitProvider,
} from '../../repositories/entities/repository.entity';
import { ownsRepository } from '../../repositories/repositories/repositories.repository';
import { RepositoryCredentialEntity } from '../../repositories/entities/repository-credential.entity';
import { GitBuildSourceConfig } from '../../applications/interfaces/source-config.interface';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { BuildJobService } from './build-job.service';
import { ClustersService } from '../../infrastructure/clusters/clusters.service';
import { DetectionOrchestratorService } from '../../frameworks/framework-core/services/detection-orchestrator.service';
import { BuildAdvisorResultDto } from '../dto/build-advisor-result.dto';

export interface TriggerBuildJobData {
  buildId?: string;
  applicationId: string | null;
  operationId: string;
  buildClusterId?: string;
  forceRebuild?: boolean;
  userId?: string;
  publicCloneUrl?: string; // Public HTTPS clone URL (skips token injection in git-clone step)
  advisorChoices?: Record<string, string>; // User-confirmed choices, e.g. { startCommand: 'node dist/main.js' }
  advisorStrategy?: string; // DeployStrategy confirmed/selected by user
  advisorDockerfile?: string; // Pre-generated Dockerfile for DOCKERFILE strategy
}

@Injectable()
export class AppBuildService {
  private readonly logger = new Logger(AppBuildService.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applicationRepository: Repository<ApplicationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(RepositoryEntity)
    private readonly repositoryRepository: Repository<RepositoryEntity>,
    @InjectRepository(RepositoryCredentialEntity)
    private readonly credentialRepository: Repository<RepositoryCredentialEntity>,
    @InjectQueue('app-build')
    private readonly buildQueue: Queue,
    private readonly appBuildsRepository: AppBuildsRepository,
    private readonly buildJobService: BuildJobService,
    private readonly encryptionService: EncryptionService,
    private readonly clustersService: ClustersService,
    private readonly detectionOrchestrator: DetectionOrchestratorService,
    private readonly buildWatcher: ApplicationBuildWatcherService,
  ) {}

  async refreshBuildFromProvider(buildId: string): Promise<AppBuildEntity> {
    const build = await this.appBuildsRepository.findById(buildId);
    if (!build) {
      throw new NotFoundException(`Build ${buildId} not found`);
    }
    if (!build.applicationId) {
      throw new BadRequestException(
        `Build ${buildId} has no linked application — cannot refresh`,
      );
    }
    if (build.provider !== BuildProvider.GITHUB_ACTIONS) {
      throw new BadRequestException(
        `Refresh is only supported for GITHUB_ACTIONS builds (got ${build.provider})`,
      );
    }
    return this.buildWatcher.reconcileBuildRow(build);
  }

  /**
   * Trigger a new build for a GIT_BUILD application.
   * Creates an InfrastructureOperation and AppBuild record, then enqueues the job.
   */
  async triggerBuild(
    applicationId: string,
    buildClusterId?: string,
    userId?: string,
    skipIfSameCommit?: boolean,
    forceRebuild?: boolean,
    advisorChoices?: Record<string, string>,
    advisorStrategy?: string,
    advisorDockerfile?: string,
  ): Promise<{
    operation: InfrastructureOperationEntity;
    build: AppBuildEntity;
    skipped?: boolean;
  }> {
    const app = await this.applicationRepository.findOne({
      where: { id: applicationId },
    });

    if (!app) {
      throw new NotFoundException(`Application ${applicationId} not found`);
    }

    if (app.sourceType !== ApplicationSourceType.GIT_BUILD) {
      throw new BadRequestException(
        `Application ${app.name} is not a GIT_BUILD type (got: ${app.sourceType})`,
      );
    }

    const sourceConfig = app.sourceConfig as GitBuildSourceConfig;
    const branch = sourceConfig?.branch || 'main';
    const clusterId = buildClusterId || app.clusterId;

    // Eager dedup: resolve HEAD commit and return existing build without touching the queue
    if (skipIfSameCommit) {
      try {
        const credential = await this.credentialRepository.findOne({
          where: {
            userId: app.userId,
            provider: GitProvider.GITHUB,
            isActive: true,
          },
          order: { createdAt: 'DESC' },
        });
        if (credential) {
          const githubToken = this.encryptionService.decrypt(
            credential.accessTokenEncrypted,
          );
          const linked = sourceConfig?.repositoryId
            ? await this.repositoryRepository.findOne({
                where: { id: sourceConfig.repositoryId },
              })
            : null;
          const repository =
            linked && ownsRepository(linked, app.userId) ? linked : null;
          const repoOwner = repository?.owner || credential.githubUsername;
          const repoName = repository?.repositoryName || app.slug;
          const octokit = new Octokit({ auth: githubToken });
          const { data } = await octokit.repos.getBranch({
            owner: repoOwner,
            repo: repoName,
            branch,
          });
          const headSha = data.commit.sha;
          const existing =
            await this.appBuildsRepository.findCompletedByCommitSha(
              applicationId,
              headSha,
            );
          if (existing) {
            this.logger.log(
              `[triggerBuild] skipIfSameCommit: commit ${headSha} already built (${existing.id}) — returning early`,
            );
            // Return a synthetic "operation" pointing at the build's existing operationId
            const existingOp = existing.operationId
              ? await this.operationRepository.findOne({
                  where: { id: existing.operationId },
                })
              : null;
            if (existingOp) {
              return { operation: existingOp, build: existing, skipped: true };
            }
          }
        }
      } catch (err) {
        this.logger.warn(
          `[triggerBuild] skipIfSameCommit check failed: ${err.message} — proceeding with normal build`,
        );
      }
    }

    const operationSteps = this.getBuildOperationSteps();
    const operation = this.operationRepository.create({
      operationType: OperationType.BUILD_APPLICATION,
      status: OperationStatus.PENDING,
      resourceType: 'application',
      resourceName: app.name,
      resourceId: app.id,
      userId,
      totalSteps: operationSteps.length,
      currentStepIndex: 0,
      currentStepProgress: 0,
      metadata: {
        applicationId: app.id,
        applicationName: app.name,
        clusterId,
        branch,
        operationSteps,
      },
    });

    const savedOperation = await this.operationRepository.save(operation);

    const jobName = this.buildJobService.buildJobName(
      app.slug || applicationId.substring(0, 8),
    );

    const build = await this.appBuildsRepository.create({
      applicationId: app.id,
      buildClusterId: clusterId,
      branch,
      k8sJobName: jobName,
      status: AppBuildStatus.PENDING,
      operationId: savedOperation.id,
      startedAt: new Date(),
    });

    const jobData: TriggerBuildJobData = {
      buildId: build.id,
      applicationId: app.id,
      operationId: savedOperation.id,
      forceRebuild: forceRebuild ?? false,
      advisorChoices,
      advisorStrategy,
      advisorDockerfile,
    };

    await this.buildQueue.add('build-from-source', jobData, {
      attempts: 1,
      timeout: 1800000, // 30 minutes
    });

    this.logger.log(
      `Build job queued for application ${app.name} (${app.id}), build: ${build.id}, operation: ${savedOperation.id}`,
    );

    return { operation: savedOperation, build };
  }

  /**
   * Pre-check: resolves HEAD commit SHA, checks for an existing completed build,
   * and returns cluster resource availability. Designed to be called by the frontend
   * before showing the Build button.
   */
  async checkBuild(
    applicationId: string,
    userId?: string,
  ): Promise<BuildCheckResponseDto> {
    const app = await this.applicationRepository.findOne({
      where: { id: applicationId },
    });
    if (!app)
      throw new NotFoundException(`Application ${applicationId} not found`);
    if (app.sourceType !== ApplicationSourceType.GIT_BUILD) {
      throw new BadRequestException(
        `Application ${app.name} is not a GIT_BUILD type`,
      );
    }

    const sourceConfig = app.sourceConfig as GitBuildSourceConfig;
    const branch = sourceConfig?.branch || 'main';
    const clusterId = app.clusterId;

    // Load repository record (for framework info persisted from last build)
    const linked = sourceConfig?.repositoryId
      ? await this.repositoryRepository.findOne({
          where: { id: sourceConfig.repositoryId },
        })
      : null;
    const repository =
      linked && ownsRepository(linked, app.userId) ? linked : null;

    const repositoryFramework = repository
      ? {
          detectedFramework: repository.detectedFramework ?? undefined,
          detectedFrontendFramework:
            repository.detectedFrontendFramework ?? undefined,
          detectedPort: repository.detectedPort ?? undefined,
        }
      : undefined;

    // Resolve HEAD commit SHA via GitHub API
    let currentCommitSha: string | undefined;
    try {
      const credential = await this.credentialRepository.findOne({
        where: {
          userId: app.userId,
          provider: GitProvider.GITHUB,
          isActive: true,
        },
        order: { createdAt: 'DESC' },
      });
      if (credential) {
        const githubToken = this.encryptionService.decrypt(
          credential.accessTokenEncrypted,
        );
        const repoOwner = repository?.owner || credential.githubUsername;
        const repoName = repository?.repositoryName || app.slug;
        const octokit = new Octokit({ auth: githubToken });
        const { data } = await octokit.repos.getBranch({
          owner: repoOwner,
          repo: repoName,
          branch,
        });
        currentCommitSha = data.commit.sha;
      }
    } catch (err) {
      this.logger.warn(
        `[checkBuild] Could not resolve HEAD commit for ${applicationId}: ${err.message}`,
      );
    }

    // Check if this commit was already built
    let existingBuild: BuildCheckResponseDto['existingBuild'];
    if (currentCommitSha) {
      const completed = await this.appBuildsRepository.findCompletedByCommitSha(
        applicationId,
        currentCommitSha,
      );
      if (completed?.imageRef) {
        existingBuild = {
          id: completed.id,
          imageRef: completed.imageRef,
          detectedFramework: completed.detectedFramework,
          detectedFrontendFramework: completed.detectedFrontendFramework,
          detectedPort: completed.detectedPort,
          completedAt: completed.completedAt,
        };
      }
    }

    // Check cluster resource availability
    let resourceCheck: BuildCheckResponseDto['resourceCheck'];
    try {
      const resources = await this.clustersService.getBuildResources(clusterId);
      resourceCheck = {
        status: resources.status === 'ok' ? 'ok' : resources.status,
        availableCpu: resources.available?.cpu,
        availableMemory: resources.available?.memory,
      };
    } catch (err) {
      this.logger.warn(
        `[checkBuild] Resource check failed for cluster ${clusterId}: ${err.message}`,
      );
      resourceCheck = { status: 'unknown' };
    }

    // Run build advisor (silent — never blocks checkBuild)
    let advisor: BuildAdvisorResultDto | undefined;
    try {
      const credential = await this.credentialRepository.findOne({
        where: {
          userId: app.userId,
          provider: GitProvider.GITHUB,
          isActive: true,
        },
        order: { createdAt: 'DESC' },
      });
      if (credential && currentCommitSha) {
        const githubToken = this.encryptionService.decrypt(
          credential.accessTokenEncrypted,
        );
        const repoOwner = repository?.owner || credential.githubUsername;
        const repoName = repository?.repositoryName || app.slug;
        const octokit = new Octokit({ auth: githubToken });
        const result = await this.detectionOrchestrator.detectFromGitHub(
          octokit,
          repoOwner,
          repoName,
          currentCommitSha,
        );
        if (result) {
          const { buildPlan } = result;
          const source =
            (buildPlan.metadata as any)?.templateVersion === 'flui-yaml'
              ? 'flui_yaml'
              : 'detector';
          advisor = {
            deployStrategy: buildPlan.deployStrategy,
            deployabilityScore: buildPlan.deployabilityScore,
            requiresUserConfirmation: buildPlan.requiresUserConfirmation,
            userChoicesRequired: (buildPlan.userChoicesRequired ?? []).map(
              (c) => ({
                field: c.field,
                description: c.description,
                options: c.options.map((o) => ({
                  label: o.label,
                  value: o.value,
                })),
                suggestedIndex: c.suggestedIndex,
              }),
            ),
            suggestedBuildCommand: buildPlan.suggestedBuildCommand,
            suggestedStartCommand: buildPlan.suggestedStartCommand,
            projectWarnings: buildPlan.projectWarnings ?? [],
            recommendedStructure: buildPlan.recommendedStructure,
            source,
          };
        }
      }
    } catch (err) {
      this.logger.warn(
        `[checkBuild] Advisor failed for ${applicationId}: ${err.message}`,
      );
    }

    return {
      canSkipBuild: !!existingBuild,
      branch,
      currentCommitSha,
      existingBuild,
      repositoryFramework,
      resourceCheck,
      advisor,
    };
  }

  async findBuildById(id: string): Promise<AppBuildEntity | null> {
    return this.appBuildsRepository.findById(id);
  }

  async findBuildsByApplicationId(
    applicationId: string,
  ): Promise<AppBuildEntity[]> {
    return this.appBuildsRepository.findByApplicationId(applicationId);
  }

  async findLatestBuildByApplicationId(
    applicationId: string,
  ): Promise<AppBuildEntity | null> {
    return this.appBuildsRepository.findLatestByApplicationId(applicationId);
  }

  /**
   * Cancel an active build:
   *  1. Remove from Bull queue if still waiting/delayed
   *  2. Delete the K8s Job + pods from the cluster
   *  3. Mark build as CANCELLED and operation as FAILED
   *  4. Reset application status to PENDING
   */
  async cancelBuild(buildId: string): Promise<void> {
    const build = await this.appBuildsRepository.findById(buildId);
    if (!build) {
      throw new NotFoundException(`Build ${buildId} not found`);
    }

    const cancellableStatuses = [
      AppBuildStatus.PENDING,
      AppBuildStatus.CLONING,
      AppBuildStatus.ANALYZING,
      AppBuildStatus.BUILDING,
      AppBuildStatus.PUSHING,
    ];
    if (!cancellableStatuses.includes(build.status)) {
      throw new BadRequestException(
        `Build ${buildId} cannot be cancelled (status: ${build.status})`,
      );
    }

    // 1. Remove from Bull queue (waiting/delayed jobs)
    try {
      const [waiting, delayed] = await Promise.all([
        this.buildQueue.getWaiting(),
        this.buildQueue.getDelayed(),
      ]);
      const queuedJob = [...waiting, ...delayed].find(
        (j) =>
          j.data?.buildId === buildId ||
          j.data?.applicationId === build.applicationId,
      );
      if (queuedJob) {
        await queuedJob
          .discard()
          .catch(() =>
            queuedJob
              .moveToFailed({ message: 'Cancelled by user' }, true)
              .catch(() => {}),
          );
        this.logger.log(`Removed build ${buildId} from queue`);
      }
    } catch (err) {
      this.logger.warn(
        `Failed to remove build ${buildId} from queue: ${err.message}`,
      );
    }

    // 2. Delete K8s Job + pods if the job was created
    if (build.k8sJobName && build.k8sJobName !== 'pending') {
      try {
        const cluster = await this.clusterRepository.findOne({
          where: { id: build.buildClusterId },
        });
        if (cluster?.kubeconfigEncrypted) {
          const kubeconfig = this.encryptionService.decrypt(
            cluster.kubeconfigEncrypted,
          );
          await this.buildJobService.deleteJob(
            kubeconfig,
            build.k8sJobName,
            buildId,
          );
          this.logger.log(
            `Deleted K8s Job ${build.k8sJobName} for cancelled build ${buildId}`,
          );
        }
      } catch (err) {
        this.logger.warn(
          `Failed to delete K8s Job for build ${buildId}: ${err.message}`,
        );
      }
    }

    // 3. Mark build as CANCELLED
    await this.appBuildsRepository.updateStatus(
      buildId,
      AppBuildStatus.CANCELLED,
      'Cancelled by user',
    );

    // 4. Mark operation as FAILED
    if (build.operationId) {
      await this.operationRepository.update(build.operationId, {
        status: OperationStatus.FAILED,
        completedAt: new Date(),
        errorMessage: 'Build cancelled by user',
      });
    }

    // 5. Reset application to PENDING (only for app-linked builds)
    if (build.applicationId) {
      await this.applicationRepository
        .update(build.applicationId, { status: ApplicationStatus.PENDING })
        .catch(() => {});
    }

    this.logger.log(
      `Build ${buildId} cancelled for application ${build.applicationId ?? 'standalone'}`,
    );
  }

  async getBuildNamespaceResources(
    clusterId: string,
  ): Promise<BuildNamespaceResourcesResponseDto> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new NotFoundException(
        `Cluster ${clusterId} not found or kubeconfig missing`,
      );
    }
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );

    const [{ jobs, pods }, pendingBuilds] = await Promise.all([
      this.buildJobService.getNamespaceResources(kubeconfig),
      this.appBuildsRepository.findByClusterIdAndStatuses(clusterId, [
        AppBuildStatus.PENDING,
      ]),
    ]);

    const totalCpuRequestMillicores = jobs.reduce(
      (s, j) => s + j.cpuRequestMillicores,
      0,
    );
    const totalMemoryRequestMiB = jobs.reduce(
      (s, j) => s + j.memoryRequestMiB,
      0,
    );

    // Resolve app slugs for queued builds (exclude standalone builds with null applicationId)
    const appIds = [
      ...new Set(pendingBuilds.map((b) => b.applicationId).filter(Boolean)),
    ];
    const apps = appIds.length
      ? await this.applicationRepository.findByIds(appIds)
      : [];
    const appSlugMap = new Map(apps.map((a) => [a.id, a.slug]));

    const queuedBuilds: QueuedBuildInfoDto[] = pendingBuilds.map((b) => ({
      buildId: b.id,
      applicationId: b.applicationId,
      appSlug: b.applicationId
        ? (appSlugMap.get(b.applicationId) ?? null)
        : null,
      branch: b.branch,
      commitSha: b.commitSha ?? null,
      ageMinutes: Math.floor(
        (Date.now() - new Date(b.createdAt).getTime()) / 60_000,
      ),
      status: b.status,
    }));

    return {
      namespace: 'flui-build',
      jobs: jobs.map((j) => ({
        name: j.name,
        status: j.status,
        ageMinutes: Math.floor(j.ageSecs / 60),
        buildId: j.buildId,
        appSlug: j.appSlug,
        purpose: j.purpose,
        cpuRequest: `${j.cpuRequestMillicores}m`,
        memoryRequest: `${j.memoryRequestMiB}Mi`,
      })),
      pods: pods.map((p) => ({
        name: p.name,
        phase: p.phase,
        ageMinutes: Math.floor(p.ageSecs / 60),
        buildId: p.buildId,
        appSlug: p.appSlug,
        containers: p.containers,
      })),
      queuedBuilds,
      totalCpuRequestMillicores,
      totalMemoryRequestMiB,
    };
  }

  async cleanupBuildNamespace(
    clusterId: string,
    dto: CleanupBuildNamespaceDto,
  ): Promise<BuildNamespaceCleanupResultDto> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new NotFoundException(
        `Cluster ${clusterId} not found or kubeconfig missing`,
      );
    }
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );

    // Active build IDs: anything not yet in a terminal state
    const activeStatuses = [
      AppBuildStatus.PENDING,
      AppBuildStatus.CLONING,
      AppBuildStatus.ANALYZING,
      AppBuildStatus.BUILDING,
      AppBuildStatus.PUSHING,
    ];
    const activeBuilds =
      await this.appBuildsRepository.findByStatuses(activeStatuses);
    const activeBuildIds = new Set(activeBuilds.map((b) => b.id));

    const { deletedJobs, deletedPods } =
      await this.buildJobService.cleanupStaleResources(
        kubeconfig,
        activeBuildIds,
        dto.olderThanMinutes ?? 0,
        dto.dryRun ?? false,
      );

    return { deletedJobs, deletedPods, dryRun: dto.dryRun ?? false };
  }

  /**
   * Trigger a standalone build (no application exists yet).
   * Used in the wizard flow: build → detect framework/name → create app.
   */
  async triggerStandaloneBuild(
    gitUrl: string,
    branch: string,
    targetClusterId: string,
    buildClusterId: string,
    userId: string,
    publicCloneUrl?: string,
  ): Promise<AppBuildEntity> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: buildClusterId },
    });
    if (!cluster)
      throw new NotFoundException(`Cluster ${buildClusterId} not found`);

    const repoNameMatch = /\/([^/]+?)(\.git)?$/.exec(gitUrl);
    const repoSlug = repoNameMatch ? repoNameMatch[1] : 'build';
    const jobName = this.buildJobService.buildJobName(repoSlug);

    const build = await this.appBuildsRepository.create({
      applicationId: null,
      targetClusterId,
      gitUrl,
      branch,
      buildClusterId,
      k8sJobName: jobName,
      status: AppBuildStatus.PENDING,
      startedAt: new Date(),
    });

    const operationSteps = this.getBuildOperationSteps();
    const operation = await this.operationRepository.save(
      this.operationRepository.create({
        operationType: OperationType.BUILD_APPLICATION,
        status: OperationStatus.PENDING,
        resourceType: 'build',
        resourceName: repoSlug,
        resourceId: build.id,
        userId,
        totalSteps: operationSteps.length,
        currentStepIndex: 0,
        currentStepProgress: 0,
        metadata: {
          gitUrl,
          branch,
          buildClusterId,
          targetClusterId,
          operationSteps,
        },
      }),
    );

    await this.appBuildsRepository.update(build.id, {
      operationId: operation.id,
    });

    const jobData: TriggerBuildJobData = {
      buildId: build.id,
      applicationId: null,
      operationId: operation.id,
      buildClusterId,
      userId,
      publicCloneUrl,
    };

    await this.buildQueue.add('build-from-source', jobData, {
      attempts: 1,
      timeout: 1800000,
    });

    this.logger.log(
      `Standalone build queued: ${build.id} (${gitUrl}@${branch}), operation: ${operation.id}`,
    );
    return build;
  }

  /**
   * Delete a standalone build (only allowed when applicationId is null).
   * Cancels the build if still active, then removes the DB record.
   */
  async deleteStandaloneBuild(buildId: string): Promise<void> {
    const build = await this.appBuildsRepository.findById(buildId);
    if (!build) throw new NotFoundException(`Build ${buildId} not found`);
    if (build.applicationId !== null) {
      throw new BadRequestException(
        `Build ${buildId} is linked to application ${build.applicationId} and cannot be deleted via this endpoint`,
      );
    }

    const activeStatuses = [
      AppBuildStatus.PENDING,
      AppBuildStatus.CLONING,
      AppBuildStatus.ANALYZING,
      AppBuildStatus.BUILDING,
      AppBuildStatus.PUSHING,
    ];
    if (activeStatuses.includes(build.status)) {
      await this.cancelBuild(buildId);
    }

    await this.appBuildsRepository.deleteById(buildId);
    this.logger.log(`Standalone build ${buildId} deleted`);
  }

  getBuildOperationSteps() {
    return [
      {
        step: OperationStep.APP_BUILD_INIT,
        description: 'Initializing build',
        weight: 5,
      },
      {
        step: OperationStep.APP_BUILD_CREATE_JOB,
        description: 'Creating K8s build job',
        weight: 10,
      },
      {
        step: OperationStep.APP_BUILD_CLONING,
        description: 'Cloning repository',
        weight: 15,
      },
      {
        step: OperationStep.APP_BUILD_ANALYZING,
        description: 'Analyzing framework with Railpack',
        weight: 10,
      },
      {
        step: OperationStep.APP_BUILD_BUILDING,
        description: 'Building image',
        weight: 45,
      },
      {
        step: OperationStep.APP_BUILD_PUSHING,
        description: 'Pushing image to registry',
        weight: 10,
      },
      {
        step: OperationStep.APP_BUILD_FINALIZE,
        description: 'Finalizing build',
        weight: 5,
      },
    ];
  }
}
