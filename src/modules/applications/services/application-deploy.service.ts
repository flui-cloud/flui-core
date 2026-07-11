import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bull';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository, In } from 'typeorm';
import { Queue } from 'bull';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { AppBuildEntity } from '../../app-builds/entities/app-build.entity';
import { AppBuildStatus } from '../../app-builds/enums/app-build-status.enum';
import { ApplicationService } from './application.service';
import { ApplicationEntity } from '../entities/application.entity';
import { AppRevisionsRepository } from '../repositories/app-revisions.repository';
import { ApplicationStatus } from '../enums/application-status.enum';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import {
  GitBuildSourceConfig,
  ApplicationSourceConfig,
} from '../interfaces/source-config.interface';
import { DeployApplicationDto } from '../dto/deploy-application.dto';
import { RollbackApplicationDto } from '../dto/rollback-application.dto';
import { CreateApplicationDto } from '../dto/create-application.dto';
import { CreateApplicationResponseDto } from '../dto/application-response.dto';
import { AppEventType, AppEventActorType } from '../enums/app-event-type.enum';
import { BuildAgentConfigService } from '../../app-builds/services/build-agent-config.service';
import { DedicatedPlacementService } from './dedicated-placement.service';
import { findSystemAppByLabel } from '../constants/system-app-catalog';
import { matchesAnyPattern } from '../utils/version-pattern';

export interface DeployApplicationJobData {
  operationId: string;
  applicationId: string;
  deployType: 'initial' | 'update' | 'rollback';
  rollbackRevisionNumber?: number;
  rollbackReason?: string;
  /**
   * The image this deploy was enqueued for. Pinned so the render can't drift to a
   * stale value re-read from the app row while concurrent deploys race — a single
   * push fans out into several deploys and they must all render the same image.
   */
  imageRef?: string;
}

export interface DeleteApplicationJobData {
  operationId: string;
  applicationId: string;
}

@Injectable()
export class ApplicationDeployService {
  private readonly logger = new Logger(ApplicationDeployService.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly applicationRepository: Repository<ApplicationEntity>,
    @InjectRepository(AppBuildEntity)
    private readonly appBuildRepository: Repository<AppBuildEntity>,
    @InjectQueue('application-deploy')
    private readonly deployQueue: Queue,
    @InjectQueue('app-build')
    private readonly buildQueue: Queue,
    private readonly applicationService: ApplicationService,
    private readonly appRevisionsRepository: AppRevisionsRepository,
    private readonly buildAgentConfig: BuildAgentConfigService,
    private readonly placementService: DedicatedPlacementService,
  ) {}

  async deploy(
    id: string,
    dto: DeployApplicationDto,
    userId?: string,
  ): Promise<InfrastructureOperationEntity> {
    const app = await this.applicationService.findById(id);

    await this.placementService.assertFitsOrThrow(app);

    if (dto.buildId) {
      return this.deployFromExistingBuild(id, dto.buildId, userId);
    }

    if (dto.useCurrentImage) {
      if (!app.imageRef)
        throw new BadRequestException(
          `Application ${id} has no image to redeploy`,
        );
      return this.triggerDeployWithImage(id, app.imageRef, userId);
    }

    // Deploy a specific pre-built image directly (works for all sourceTypes).
    // Checked before the GIT_BUILD guard so that deploying a known GHCR tag
    // via imageRef skips the build pipeline entirely.
    if (dto.imageRef) {
      return this.triggerDeployWithImage(id, dto.imageRef, userId);
    }

    // Path B: delegate to build pipeline for git_build source type.
    // The in-cluster build agent is demoted in favor of the managed offering
    // and is OFF by default — see BuildAgentConfigService. When disabled,
    // GIT_BUILD apps should be built via the GitHub Actions workflow path
    // (generateAndCommitWorkflowV3 + ApplicationBuildWatcherService), which
    // does not allocate anything in the flui-build namespace.
    if (app.sourceType === ApplicationSourceType.GIT_BUILD) {
      if (!this.buildAgentConfig.isInClusterBuildAgentEnabled()) {
        throw new ServiceUnavailableException(
          'In-cluster build agent is disabled. GIT_BUILD apps should be built ' +
            'via the GitHub Actions workflow path. Set ' +
            'FLUI_IN_CLUSTER_BUILD_AGENT_ENABLED=true to re-enable.',
        );
      }
      return this.triggerBuildPipeline(app, userId);
    }

    const isInitial = app.status === ApplicationStatus.PENDING;
    const deployType = isInitial ? 'initial' : 'update';

    if (isInitial) {
      await this.applicationService.updateStatus(
        id,
        ApplicationStatus.PROVISIONING,
      );
    } else {
      await this.applicationService.updateStatus(
        id,
        ApplicationStatus.UPDATING,
      );
    }

    const operationSteps = this.getDeployOperationSteps();
    const operation = this.operationRepository.create({
      operationType: OperationType.DEPLOY_APPLICATION,
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
        clusterId: app.clusterId,
        deployType,
        operationSteps,
      },
    });

    const savedOperation = await this.operationRepository.save(operation);

    const jobData: DeployApplicationJobData = {
      operationId: savedOperation.id,
      applicationId: app.id,
      deployType,
    };

    await this.deployQueue.add('deploy-application', jobData, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      timeout: 300000,
    });

    this.logger.log(
      `Deploy job queued for application ${app.name} (${app.id}), operation: ${savedOperation.id}`,
    );

    return savedOperation;
  }

  private async deployFromExistingBuild(
    applicationId: string,
    buildId: string,
    userId?: string,
  ): Promise<InfrastructureOperationEntity> {
    const build = await this.appBuildRepository.findOne({
      where: { id: buildId },
    });
    if (!build) throw new NotFoundException(`Build ${buildId} not found`);
    if (build.applicationId !== applicationId) {
      throw new BadRequestException(
        `Build ${buildId} does not belong to application ${applicationId}`,
      );
    }
    if (build.status !== AppBuildStatus.COMPLETED || !build.imageRef) {
      throw new BadRequestException(
        `Build ${buildId} is not completed or has no imageRef`,
      );
    }
    return this.triggerDeployWithImage(applicationId, build.imageRef, userId, {
      buildId: build.id,
    });
  }

  async rollback(
    id: string,
    dto: RollbackApplicationDto,
    userId?: string,
  ): Promise<InfrastructureOperationEntity> {
    if (!dto.revisionNumber && !dto.buildId) {
      throw new BadRequestException(
        'Either revisionNumber or buildId must be provided',
      );
    }

    const app = await this.applicationService.findById(id);

    // Resolve target revision — either by revisionNumber or by buildId
    const targetRevision = dto.revisionNumber
      ? await this.appRevisionsRepository.findByApplicationIdAndRevisionNumber(
          id,
          dto.revisionNumber,
        )
      : await this.appRevisionsRepository.findOne({
          where: { applicationId: id, buildId: dto.buildId },
        });

    if (!targetRevision) {
      const ref = dto.revisionNumber
        ? `revision ${dto.revisionNumber}`
        : `build ${dto.buildId}`;
      throw new NotFoundException(
        `No revision found for ${ref} on application ${id}`,
      );
    }

    const revisionNumber = targetRevision.revisionNumber;

    await this.applicationService.updateStatus(
      id,
      ApplicationStatus.ROLLING_BACK,
    );

    const operationSteps = this.getDeployOperationSteps();
    const operation = this.operationRepository.create({
      operationType: OperationType.ROLLBACK_APPLICATION,
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
        clusterId: app.clusterId,
        deployType: 'rollback',
        targetRevisionNumber: revisionNumber,
        rollbackReason: dto.reason,
        operationSteps,
      },
    });

    const savedOperation = await this.operationRepository.save(operation);

    const jobData: DeployApplicationJobData = {
      operationId: savedOperation.id,
      applicationId: app.id,
      deployType: 'rollback',
      rollbackRevisionNumber: revisionNumber,
      rollbackReason: dto.reason,
    };

    await this.deployQueue.add('deploy-application', jobData, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      timeout: 300000,
    });

    this.logger.log(
      `Rollback job queued for application ${app.name} to revision ${revisionNumber}`,
    );

    return savedOperation;
  }

  async deleteApplication(
    id: string,
    userId?: string,
  ): Promise<InfrastructureOperationEntity> {
    this.logger.log(
      `[DELETE] deleteApplication() entry id=${id} userId=${userId ?? 'n/a'}`,
    );
    const app = await this.applicationService.findById(id);
    this.logger.log(
      `[DELETE] Loaded application ${app.name} (${app.id}) status=${app.status} systemProtected=${app.systemProtected}`,
    );

    if (app.systemProtected) {
      this.logger.warn(
        `[DELETE] Rejected: system-protected application ${app.name}`,
      );
      throw new BadRequestException(
        `Cannot delete system-protected application: ${app.name}`,
      );
    }

    if (
      app.status === ApplicationStatus.DELETING ||
      app.status === ApplicationStatus.DELETED
    ) {
      this.logger.log(
        `[DELETE] App already in ${app.status} state — checking for in-flight operation`,
      );
      const existing = await this.operationRepository.findOne({
        where: {
          resourceId: id,
          operationType: OperationType.DELETE_APPLICATION,
          status: In([OperationStatus.PENDING, OperationStatus.IN_PROGRESS]),
        },
        order: { createdAt: 'DESC' },
      });

      if (existing) {
        const ageMs = Date.now() - existing.createdAt.getTime();
        const staleAfterMs = 10 * 60 * 1000; // 10 minutes
        this.logger.log(
          `[DELETE] Found existing operation ${existing.id} status=${existing.status} ageMs=${ageMs}`,
        );

        if (ageMs < staleAfterMs) {
          this.logger.log(
            `[DELETE] Delete already in progress for ${app.name}, returning existing operation ${existing.id}`,
          );
          return existing;
        }

        // Operation is stale — mark it failed and re-queue
        this.logger.warn(
          `[DELETE] Operation ${existing.id} for ${app.name} is stale (${Math.round(ageMs / 60000)}min), re-queuing`,
        );
        await this.operationRepository.update(existing.id, {
          status: OperationStatus.FAILED,
          completedAt: new Date(),
          errorMessage: 'Job stuck in queue — automatically re-queued',
        });
      } else {
        this.logger.log(
          `[DELETE] No in-flight operation found, will create a new one`,
        );
      }
      // No active (or stale) operation found — fall through and re-queue
    }

    this.logger.log(`[DELETE] Marking application ${id} status=DELETING`);
    await this.applicationService.updateStatus(id, ApplicationStatus.DELETING);

    const operationSteps = this.getDeleteOperationSteps();
    const operation = this.operationRepository.create({
      operationType: OperationType.DELETE_APPLICATION,
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
        clusterId: app.clusterId,
        operationSteps,
      },
    });

    const savedOperation = await this.operationRepository.save(operation);
    this.logger.log(
      `[DELETE] Persisted operation ${savedOperation.id} (totalSteps=${savedOperation.totalSteps})`,
    );

    const jobData: DeleteApplicationJobData = {
      operationId: savedOperation.id,
      applicationId: app.id,
    };

    this.logger.log(
      `[DELETE] Enqueuing delete-application job on 'application-deploy' queue for op=${savedOperation.id}`,
    );
    const job = await this.deployQueue.add('delete-application', jobData, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      timeout: 120000,
    });
    this.logger.log(
      `[DELETE] Job enqueued id=${job.id} name=${job.name} op=${savedOperation.id} app=${app.id}`,
    );

    // Fire-and-forget: scrub any stuck jobs for this app from the build queue.
    // Kept off the request path because Bull's getWaiting/getActive/getDelayed
    // against a loaded Redis can take tens of seconds even when the result is empty.
    // Errors are already best-effort (just warnings), so losing them here is fine.
    void this.cleanBuildQueueForApp(app.id);

    this.logger.log(
      `[DELETE] deleteApplication() returning — app=${app.name} (${app.id}) op=${savedOperation.id}`,
    );

    return savedOperation;
  }

  /**
   * Best-effort cleanup of stuck/pending build jobs for an application whose
   * delete has just been enqueued. Runs out-of-band (no caller awaits it) so
   * slow Redis scans can't block the HTTP request.
   */
  private async cleanBuildQueueForApp(applicationId: string): Promise<void> {
    const startedAt = Date.now();
    try {
      this.logger.log(
        `[DELETE] (bg) Scanning build queue for stuck jobs for app ${applicationId}`,
      );
      const [waitingJobs, activeJobs, delayedJobs] = await Promise.all([
        this.buildQueue.getWaiting(),
        this.buildQueue.getActive(),
        this.buildQueue.getDelayed(),
      ]);
      const appJobs = [...waitingJobs, ...activeJobs, ...delayedJobs].filter(
        (j) => j.data?.applicationId === applicationId,
      );
      this.logger.log(
        `[DELETE] (bg) Build queue scan (${Date.now() - startedAt}ms): waiting=${waitingJobs.length} active=${activeJobs.length} delayed=${delayedJobs.length} appMatching=${appJobs.length}`,
      );
      if (appJobs.length === 0) return;

      await Promise.all(
        appJobs.map((j) =>
          j
            .discard()
            .catch(() =>
              j
                .moveToFailed({ message: 'Application deleted' }, true)
                .catch(() => {}),
            ),
        ),
      );
      this.logger.log(
        `[DELETE] (bg) Discarded ${appJobs.length} build queue job(s) for deleted application ${applicationId}`,
      );
    } catch (err) {
      this.logger.warn(
        `[DELETE] (bg) Failed to clean build queue for application ${applicationId}: ${err.message}`,
      );
    }
  }

  /**
   * Trigger Path B build pipeline.
   * Enqueues directly to the app-build Bull queue (no service import → avoids circular dep).
   */
  private async triggerBuildPipeline(
    app: ApplicationEntity,
    userId?: string,
  ): Promise<InfrastructureOperationEntity> {
    const operationSteps = [
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
        description: 'Analyzing framework',
        weight: 10,
      },
      {
        step: OperationStep.APP_BUILD_BUILDING,
        description: 'Building image',
        weight: 45,
      },
      {
        step: OperationStep.APP_BUILD_PUSHING,
        description: 'Pushing image',
        weight: 10,
      },
      {
        step: OperationStep.APP_BUILD_FINALIZE,
        description: 'Finalizing build',
        weight: 5,
      },
    ];

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
        clusterId: app.clusterId,
        operationSteps,
      },
    });

    const savedOperation = await this.operationRepository.save(operation);

    // AppBuildEntity is created by the processor when buildId is not provided.
    await this.buildQueue.add(
      'build-from-source',
      {
        applicationId: app.id,
        operationId: savedOperation.id,
      },
      {
        attempts: 1,
        timeout: 1800000,
      },
    );

    this.logger.log(
      `Build job enqueued for application ${app.name} (${app.id}), operation: ${savedOperation.id}`,
    );

    return savedOperation;
  }

  /**
   * Atomically create an application from a completed standalone build and trigger the first deploy.
   * Race-guarded: only one caller can claim a given build (UPDATE WHERE applicationId IS NULL).
   */
  async createFromBuild(
    clusterId: string,
    dto: CreateApplicationDto,
    userId?: string,
    userEmail?: string,
  ): Promise<CreateApplicationResponseDto> {
    const buildId = dto.buildId;

    // 1. Validate the build
    const build = await this.appBuildRepository.findOne({
      where: { id: buildId },
    });
    if (!build) throw new NotFoundException(`Build ${buildId} not found`);
    if (build.status !== AppBuildStatus.COMPLETED) {
      throw new BadRequestException(
        `Build ${buildId} is not COMPLETED (status: ${build.status})`,
      );
    }
    if (build.applicationId !== null) {
      throw new BadRequestException(
        `Build ${buildId} is already linked to application ${build.applicationId}`,
      );
    }
    if (!build.imageRef) {
      throw new BadRequestException(`Build ${buildId} has no imageRef`);
    }
    if (build.targetClusterId && build.targetClusterId !== clusterId) {
      throw new BadRequestException(
        `Build ${buildId} targets cluster ${build.targetClusterId}, not ${clusterId}`,
      );
    }

    // 2. Create the application
    const appEntity = await this.applicationService.create(
      clusterId,
      dto,
      userId,
      userEmail,
    );

    // 3. Race guard: atomically claim the build for this application
    const result = await this.appBuildRepository.update(
      { id: buildId, applicationId: IsNull() },
      { applicationId: appEntity.id },
    );
    if (result.affected === 0) {
      await this.applicationService
        .updateStatus(appEntity.id, ApplicationStatus.FAILED)
        .catch(() => {});
      throw new ConflictException(
        `Build ${buildId} was already claimed by another application`,
      );
    }

    // 4. Set imageRef on application
    await this.applicationRepository.update(appEntity.id, {
      imageRef: build.imageRef,
    });

    // Persist gitUrl and branch from standalone build into sourceConfig so future rebuilds can resolve the repo and branch
    if (
      build.gitUrl &&
      !(appEntity.sourceConfig as GitBuildSourceConfig)?.repositoryId
    ) {
      await this.applicationRepository.update(appEntity.id, {
        sourceConfig: {
          ...(appEntity.sourceConfig as GitBuildSourceConfig),
          gitUrl: build.gitUrl,
          branch: build.branch,
        } as ApplicationSourceConfig,
      });
    }

    // 5. Create first revision
    const revision = await this.appRevisionsRepository.createAuditEvent({
      applicationId: appEntity.id,
      eventType: AppEventType.DEPLOY,
      actor: { type: AppEventActorType.API },
      revisionNumber: 1,
      buildId,
      imageRef: build.imageRef,
      commitSha: build.commitSha,
      sourceConfigSnapshot: appEntity.sourceConfig,
      envSnapshot: appEntity.env,
      resourcesSnapshot: appEntity.resources,
      replicas: appEntity.replicas,
      status: ApplicationStatus.PROVISIONING,
      deployedBy: userId,
    });

    // 6. Point app to first revision
    await this.applicationRepository.update(appEntity.id, {
      currentRevisionId: revision.id,
      status: ApplicationStatus.PROVISIONING,
    });

    // 7. Enqueue deploy
    const deployOperation = await this.triggerDeployWithImage(
      appEntity.id,
      build.imageRef,
      userId,
    );

    // 8. Update revision with operationId (best-effort)
    await this.appRevisionsRepository
      .update(revision.id, { operationId: deployOperation.id })
      .catch(() => {});

    const application = this.applicationService.toResponseDto(
      await this.applicationService.findById(appEntity.id),
    );

    return {
      application,
      operation: {
        id: deployOperation.id,
        status: deployOperation.status,
        totalSteps: deployOperation.totalSteps,
        operationType: deployOperation.operationType,
      },
      firstRevisionId: revision.id,
    };
  }

  /**
   * Called by AppBuildProcessor after a successful build, by the GitHub
   * Actions webhook, and by the background build watcher (polling fallback).
   * Updates the application's imageRef and enqueues a deploy job.
   *
   * Idempotent: if a pending/in-progress deploy already exists for the same
   * imageRef, returns that operation instead of queuing a duplicate. This
   * protects against the webhook and the poller racing on the same build.
   */
  async triggerDeployWithImage(
    applicationId: string,
    imageRef: string,
    userId?: string,
    extras?: { buildId?: string },
  ): Promise<InfrastructureOperationEntity> {
    const app = await this.applicationService.findById(applicationId);
    const lastReleaseOp = await this.operationRepository.findOne({
      where: {
        resourceId: applicationId,
        operationType: In([
          OperationType.DEPLOY_APPLICATION,
          OperationType.ROLLBACK_APPLICATION,
        ]),
        status: OperationStatus.COMPLETED,
      },
      order: { createdAt: 'DESC' },
    });
    const previousImageRef =
      (lastReleaseOp?.metadata as { imageRef?: string } | undefined)
        ?.imageRef ?? null;

    // Curated-version guard for system apps: blocks deploys outside the
    // allowed range regardless of which entry point reached this method
    // (deploy, redeployGhcrTag, etc.).
    this.assertImageRefAllowed(app, imageRef);

    // Idempotency guard: if we already have an operation for this exact
    // imageRef that is still pending or in-progress, reuse it rather than
    // launching a second deploy on top of itself.
    const existingOp = await this.operationRepository.findOne({
      where: {
        resourceId: applicationId,
        operationType: OperationType.DEPLOY_APPLICATION,
        status: In([OperationStatus.PENDING, OperationStatus.IN_PROGRESS]),
      },
      order: { createdAt: 'DESC' },
    });
    if (existingOp && existingOp.metadata?.imageRef === imageRef) {
      this.logger.log(
        `Deploy for ${app.name} with imageRef ${imageRef} already in progress (op ${existingOp.id}), returning existing operation`,
      );
      return existingOp;
    }

    // Update imageRef and sourceConfig directly on the application
    await this.applicationRepository.update(applicationId, {
      imageRef,
      sourceConfig: {
        ...app.sourceConfig,
        imageRef,
      } as ApplicationSourceConfig,
    });

    // "Initial" deploy = first time this app goes from a pre-deploy state
    // (PENDING from the create flow, or AWAITING_BUILD from the git_build
    // flow) into PROVISIONING. Subsequent calls trigger rolling updates.
    const isInitial =
      app.status === ApplicationStatus.PENDING ||
      app.status === ApplicationStatus.AWAITING_BUILD;
    const deployType = isInitial ? 'initial' : 'update';

    await this.applicationService.updateStatus(
      applicationId,
      isInitial ? ApplicationStatus.PROVISIONING : ApplicationStatus.UPDATING,
    );

    const operationSteps = this.getDeployOperationSteps();
    const operation = this.operationRepository.create({
      operationType: OperationType.DEPLOY_APPLICATION,
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
        clusterId: app.clusterId,
        deployType,
        imageRef,
        digest: this.extractDigestFromImageRef(imageRef),
        previousImageRef,
        buildId: extras?.buildId,
        operationSteps,
      },
    });

    const savedOperation = await this.operationRepository.save(operation);

    await this.deployQueue.add(
      'deploy-application',
      {
        operationId: savedOperation.id,
        applicationId: app.id,
        deployType,
        imageRef,
      },
      {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        timeout: 300000,
      },
    );

    this.logger.log(
      `Deploy job triggered post-build for application ${app.name} (imageRef: ${imageRef})`,
    );

    return savedOperation;
  }

  private getDeployOperationSteps() {
    return [
      {
        step: OperationStep.APP_DEPLOY_INIT,
        description: 'Initializing deployment',
        weight: 5,
      },
      {
        step: OperationStep.APP_DEPLOY_GENERATE_MANIFESTS,
        description: 'Generating K8s manifests',
        weight: 10,
      },
      {
        step: OperationStep.APP_DEPLOY_APPLY_MANIFESTS,
        description: 'Applying manifests to cluster',
        weight: 30,
      },
      {
        step: OperationStep.APP_DEPLOY_WAIT_READY,
        description: 'Waiting for resources to be ready',
        weight: 45,
      },
      {
        step: OperationStep.APP_DEPLOY_FINALIZE,
        description: 'Finalizing deployment',
        weight: 10,
      },
    ];
  }

  private getDeleteOperationSteps() {
    return [
      {
        step: OperationStep.APP_DELETE_INIT,
        description: 'Initializing deletion',
        weight: 10,
      },
      {
        step: OperationStep.APP_DELETE_K8S_RESOURCES,
        description: 'Removing Kubernetes resources',
        weight: 80,
      },
      {
        step: OperationStep.APP_DELETE_FINALIZE,
        description: 'Finalizing deletion',
        weight: 10,
      },
    ];
  }

  /**
   * For RAW_MANIFEST system apps with curated `allowedVersions`, reject
   * deploy attempts whose imageRef tag falls outside the supported range.
   * Defense in depth: the version-picker UI already filters these out, but
   * direct API calls would otherwise bypass the curation.
   *
   * Non-system apps and system apps without allowedVersions are unrestricted.
   */
  private assertImageRefAllowed(
    app: ApplicationEntity,
    imageRef: string,
  ): void {
    if (!app.systemProtected) return;
    if (app.sourceType !== ApplicationSourceType.RAW_MANIFEST) return;

    const label = app.labels?.['app'] ?? app.slug;
    const def = findSystemAppByLabel(label);
    const allowed = def?.imageSource?.allowedVersions;
    if (!allowed || allowed.length === 0) return;
    if (allowed.includes('*')) return;

    const lastColon = imageRef.lastIndexOf(':');
    const lastSlash = imageRef.lastIndexOf('/');
    const tag =
      lastColon > lastSlash ? imageRef.slice(lastColon + 1) : 'latest';

    if (!matchesAnyPattern(tag, allowed)) {
      throw new BadRequestException(
        `Version "${tag}" is not in the allowed range for system app "${app.name}". Allowed patterns: ${allowed.join(', ')}.`,
      );
    }
  }

  private extractDigestFromImageRef(
    imageRef: string | null | undefined,
  ): string | null {
    if (!imageRef) return null;
    const at = imageRef.lastIndexOf('@');
    if (at < 0) return null;
    const rest = imageRef.slice(at + 1);
    return /^sha256:[0-9a-f]{64}$/.test(rest) ? rest : null;
  }
}
