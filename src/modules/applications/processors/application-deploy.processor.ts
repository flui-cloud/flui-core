import { Processor, Process, InjectQueue } from '@nestjs/bull';
import {
  Inject,
  Logger,
  forwardRef,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import { Job, Queue } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import * as k8s from '@kubernetes/client-node';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
  OperationType,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { AppRevisionsRepository } from '../repositories/app-revisions.repository';
import { AppResourcesRepository } from '../repositories/app-resources.repository';
import {
  ApplicationManifestGeneratorService,
  GeneratedManifest,
} from '../services/application-manifest-generator.service';
import { ApplicationReconciliationService } from '../services/application-reconciliation.service';
import {
  DeployApplicationJobData,
  DeleteApplicationJobData,
} from '../services/application-deploy.service';
import { ApplicationEntity } from '../entities/application.entity';
import { ApplicationStatus } from '../enums/application-status.enum';
import { ApplicationSourceType } from '../enums/application-source-type.enum';
import { ApplicationResourceStatus } from '../enums/application-resource-status.enum';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';
import { AppEventType, AppEventActorType } from '../enums/app-event-type.enum';
import { ApplicationEventsGateway } from '../gateway/application-events.gateway';
import { GhcrSecretRefreshService } from '../services/ghcr-secret-refresh.service';
import { AppEndpointEntity } from '../../dns/entities/app-endpoint.entity'; // used via EntityManager only
import { DeploymentGuardService } from '../../scaling/services/deployment-guard.service';
import { DeployConfigService } from '../services/deploy-config.service';
import { CatalogInstallEntity } from '../../catalog/entities/catalog-install.entity';
import { CatalogInstallStatus } from '../../catalog/enums/catalog-install-status.enum';
import { ApplicationExposure } from '../enums/application-exposure.enum';
import { AppEndpointService } from '../../dns/services/app-endpoint.service';
import { DockerImageSourceConfig } from '../interfaces/source-config.interface';
import { AppEndpointReconciliationService } from '../../dns/services/app-endpoint-reconciliation.service';
import { ApplicationSourceDeployService } from '../services/application-source-deploy.service';
import { findSystemAppByLabel } from '../constants/system-app-catalog';
import { ApplicationResourceKind } from '../enums/application-resource-kind.enum';
import { AppResourceEntity } from '../entities/app-resource.entity';
import { DedicatedPlacementService } from '../services/dedicated-placement.service';

@Processor('application-deploy')
export class ApplicationDeployProcessor {
  private readonly logger = new Logger(ApplicationDeployProcessor.name);

  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    @InjectRepository(CatalogInstallEntity)
    private readonly catalogInstallRepository: Repository<CatalogInstallEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly appRevisionsRepository: AppRevisionsRepository,
    private readonly appResourcesRepository: AppResourcesRepository,
    private readonly manifestGenerator: ApplicationManifestGeneratorService,
    private readonly reconciliationService: ApplicationReconciliationService,
    private readonly eventsGateway: ApplicationEventsGateway,
    private readonly ghcrSecretRefresh: GhcrSecretRefreshService,
    private readonly deployConfig: DeployConfigService,
    private readonly dedicatedPlacement: DedicatedPlacementService,
    @Optional()
    @Inject(forwardRef(() => DeploymentGuardService))
    private readonly deploymentGuard?: DeploymentGuardService,
    @Optional()
    @Inject(forwardRef(() => AppEndpointService))
    private readonly appEndpointService?: AppEndpointService,
    @Optional()
    @Inject(forwardRef(() => AppEndpointReconciliationService))
    private readonly appEndpointReconciliationService?: AppEndpointReconciliationService,
    @Optional()
    @Inject(forwardRef(() => ApplicationSourceDeployService))
    private readonly applicationSourceDeployService?: ApplicationSourceDeployService,
    @Optional()
    @InjectQueue('backup')
    private readonly backupQueue?: Queue,
  ) {}

  /**
   * Auto-pin a dedicated app to the worker with the most free capacity, unless
   * it is already pinned or opted into the master. Fails loudly if no worker
   * exists. Single chokepoint for both catalog and app deploys.
   */
  private async ensureDedicatedPlacement(
    app: ApplicationEntity,
  ): Promise<ApplicationEntity> {
    if (app.persistenceScope !== 'dedicated') return app;
    if (app.dedicatedNodeName || app.allowMasterPlacement) return app;

    const worker = await this.dedicatedPlacement.selectBestWorker(app);
    if (!worker) {
      throw new BadRequestException({
        code: 'NO_WORKER_FOR_DEDICATED_APP',
        message:
          `App "${app.slug}" uses dedicated (node-local) storage, which must run on a ` +
          `worker node, but this cluster has none. Add one with \`flui node add\`, or ` +
          `redeploy with --allow-master to place it on the control-plane node.`,
      });
    }

    this.logger.warn(
      `Dedicated app ${app.slug} auto-pinned to worker ${worker} (most free capacity)`,
    );
    const updated = await this.applicationsRepository.update(app.id, {
      dedicatedNodeName: worker,
    });
    return updated ?? app;
  }

  /**
   * Pre-deploy snapshot hook: enqueues a Velero scoped Backup for the app
   * namespace, awaits completion (timeout 5min), and either fails-closed (REQUIRED)
   * or fails-open with warning (BEST_EFFORT) per app.preDeploySnapshotPolicy.
   */
  private async runPreDeploySnapshotHook(
    app: ApplicationEntity,
    deployId: string,
    operationId: string,
  ): Promise<void> {
    if (!app.preDeploySnapshotEnabled || !this.backupQueue) return;
    const policy = app.preDeploySnapshotPolicy ?? 'best_effort';
    try {
      const job = await this.backupQueue.add(
        'pre-deploy-snapshot-trigger',
        {
          applicationId: app.id,
          clusterId: app.clusterId,
          userId: app.userId,
          deployId,
          namespace: app.k8sNamespace,
          parentOperationId: operationId,
        },
        { attempts: 1 },
      );
      const timeoutMs = 5 * 60 * 1000;
      await Promise.race([
        job.finished(),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error('pre-deploy snapshot timeout')),
            timeoutMs,
          ),
        ),
      ]);
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (policy === 'required') {
        throw new Error(`Pre-deploy snapshot failed (required): ${msg}`);
      }
      this.logger.warn(
        `[pre-deploy-snapshot] best-effort failure for app ${app.id}: ${msg}. Deploy continues.`,
      );
    }
  }

  /**
   * After a successful deploy, ensure that an `exposure=internal` app has
   * its `endpointType=INTERNAL` AppEndpoint row + reconciliation triggered.
   * Idempotent (createInternalEndpoint short-circuits when one exists).
   * Failures are non-fatal: we log and proceed — the user can retry by
   * triggering the reconciliation manually from the dashboard.
   */
  private async ensureInternalEndpoint(
    application: ApplicationEntity,
  ): Promise<void> {
    if (application.exposure !== ApplicationExposure.INTERNAL) return;
    if (!this.appEndpointService || !this.appEndpointReconciliationService) {
      this.logger.warn(
        `ensureInternalEndpoint(${application.id}): AppEndpointService not wired, skipping (likely a test harness)`,
      );
      return;
    }
    try {
      const endpoint =
        await this.appEndpointService.createInternalEndpoint(application);
      this.appEndpointReconciliationService
        .reconcile(endpoint.id)
        .catch((err) =>
          this.logger.warn(
            `Internal endpoint reconciliation failed for ${endpoint.id} (app ${application.id}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          ),
        );
    } catch (err) {
      this.logger.warn(
        `ensureInternalEndpoint(${application.id}) failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  @Process('deploy-application')
  async handleDeploy(job: Job<DeployApplicationJobData>): Promise<void> {
    const {
      operationId,
      applicationId,
      deployType,
      rollbackRevisionNumber,
      rollbackReason,
    } = job.data;

    this.logger.log(
      `Processing deploy job for application ${applicationId}, type: ${deployType}`,
    );

    const startedAt = Date.now();
    const opType =
      deployType === 'rollback'
        ? OperationType.ROLLBACK_APPLICATION
        : OperationType.DEPLOY_APPLICATION;

    try {
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        0,
        OperationStep.APP_DEPLOY_INIT,
      );
      this.eventsGateway.emitOperationProgress(applicationId, {
        appId: applicationId,
        operationId,
        operationType: opType,
        percentage: 0,
        currentStep: 1,
        totalSteps: 5,
        message: 'Initializing deployment...',
        timestamp: new Date(),
      });

      const app = await this.applicationsRepository.findById(applicationId);
      if (!app) {
        throw new Error(`Application ${applicationId} not found`);
      }

      const cluster = await this.clusterRepository.findOne({
        where: { id: app.clusterId },
      });
      if (!cluster?.kubeconfigEncrypted) {
        throw new Error(
          `Cluster ${app.clusterId} not found or kubeconfig missing`,
        );
      }

      const kubeconfig = this.encryptionService.decrypt(
        cluster.kubeconfigEncrypted,
      );

      const placedApp = await this.ensureDedicatedPlacement(app);

      // If rollback, restore config from target revision
      let appForManifests = placedApp;
      if (deployType === 'rollback' && rollbackRevisionNumber) {
        appForManifests = await this.restoreFromRevision(
          app,
          rollbackRevisionNumber,
        );
      }

      // Ensure target namespace exists (creates it on first deploy, no-op afterwards)
      await this.kubernetesService.ensureNamespaceExists(
        kubeconfig,
        app.k8sNamespace,
        {
          'flui.cloud/tier': 'user',
          ...(app.userId ? { 'flui.cloud/owner': app.userId } : {}),
        },
      );

      // RAW_MANIFEST system apps own only their image tag — manifests live in
      // bootstrap-scripts and are not regenerated. We patch the container
      // image directly and let K8s drive the rolling update.
      if (
        app.sourceType === ApplicationSourceType.RAW_MANIFEST &&
        app.systemProtected
      ) {
        await this.handleSystemAppImagePatch(
          appForManifests,
          kubeconfig,
          operationId,
          opType,
          deployType,
          rollbackRevisionNumber,
          rollbackReason,
          startedAt,
        );
        return;
      }

      // Pre-deploy snapshot hook (opt-in per app)
      if (deployType !== 'initial') {
        await this.runPreDeploySnapshotHook(
          app,
          job.data.applicationId,
          operationId,
        );
      }

      // Generate manifests
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        15,
        OperationStep.APP_DEPLOY_GENERATE_MANIFESTS,
      );
      this.eventsGateway.emitOperationProgress(applicationId, {
        appId: applicationId,
        operationId,
        operationType: opType,
        percentage: 15,
        currentStep: 2,
        totalSteps: 5,
        message: 'Generating Kubernetes manifests...',
        timestamp: new Date(),
      });
      // For GIT_BUILD apps, ensure the ghcr.io pull secret exists in the app namespace
      let imagePullSecretName: string | undefined;
      this.logger.log(
        `Pull secret check: sourceType=${app.sourceType}, userId=${app.userId}, imageRef=${app.imageRef}`,
      );
      if (app.sourceType === ApplicationSourceType.GIT_BUILD && app.userId) {
        imagePullSecretName = await this.ensureGhcrPullSecret(kubeconfig, app);
        this.logger.log(
          `Pull secret result: ${imagePullSecretName ?? 'undefined (skipped or failed)'}`,
        );
      } else {
        this.logger.log('Pull secret skipped: not GIT_BUILD or no userId');
      }

      const manifests = this.manifestGenerator.generateForDockerImage(
        appForManifests,
        imagePullSecretName,
      );
      this.logger.log(
        `Generated ${manifests.length} manifests for ${app.name}`,
      );

      // Apply manifests
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        30,
        OperationStep.APP_DEPLOY_APPLY_MANIFESTS,
      );
      this.eventsGateway.emitOperationProgress(applicationId, {
        appId: applicationId,
        operationId,
        operationType: opType,
        percentage: 30,
        currentStep: 3,
        totalSteps: 5,
        message: 'Applying manifests to cluster...',
        timestamp: new Date(),
      });

      if (deployType !== 'initial') {
        await this.appResourcesRepository.deleteByApplicationId(applicationId);
      }
      await this.applyManifests(
        applicationId,
        app.k8sNamespace,
        manifests,
        kubeconfig,
      );

      // Open the deployment guard BEFORE waiting for readiness, so pod-level
      // crashes that happen during the wait (OOMKilled, CrashLoop, missing
      // secret, etc.) are captured even when waitForAllReady times out and
      // the deploy fails. Fire-and-forget — the guard self-closes after ~2min
      // or on critical diagnosis.
      if (this.deploymentGuard) {
        void this.deploymentGuard
          .open(app)
          .catch((err) =>
            this.logger.warn(
              `Deployment guard failed to open for ${app.slug}: ${err.message}`,
            ),
          );
      }

      // Wait for readiness
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        60,
        OperationStep.APP_DEPLOY_WAIT_READY,
      );
      this.eventsGateway.emitOperationProgress(applicationId, {
        appId: applicationId,
        operationId,
        operationType: opType,
        percentage: 60,
        currentStep: 4,
        totalSteps: 5,
        message: 'Waiting for pods to be ready...',
        timestamp: new Date(),
      });
      await this.waitForAllReady(kubeconfig, app, manifests);

      // Finalize — create revision snapshot
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        90,
        OperationStep.APP_DEPLOY_FINALIZE,
      );
      this.eventsGateway.emitOperationProgress(applicationId, {
        appId: applicationId,
        operationId,
        operationType: opType,
        percentage: 90,
        currentStep: 5,
        totalSteps: 5,
        message: 'Finalizing deployment...',
        timestamp: new Date(),
      });

      const revisionNumber =
        await this.appRevisionsRepository.getNextRevisionNumber(applicationId);
      const eventType =
        deployType === 'rollback' ? AppEventType.ROLLBACK : AppEventType.DEPLOY;
      const revision = await this.appRevisionsRepository.createAuditEvent({
        applicationId,
        eventType,
        actor: { type: AppEventActorType.SYSTEM, id: 'system' },
        changeMetadata: {
          imageRef:
            appForManifests.imageRef ||
            (appForManifests.sourceConfig as DockerImageSourceConfig)?.imageRef,
          isInitial: deployType === 'initial',
          rollbackFromRevision: rollbackRevisionNumber ?? null,
        },
        revisionNumber,
        imageRef:
          appForManifests.imageRef ||
          (appForManifests.sourceConfig as DockerImageSourceConfig)?.imageRef,
        sourceConfigSnapshot: appForManifests.sourceConfig,
        envSnapshot: appForManifests.env,
        resourcesSnapshot: appForManifests.resources,
        replicas: appForManifests.replicas,
        status: ApplicationStatus.RUNNING,
        deployedBy: 'system',
        operationId,
        k8sResourceHashes: this.buildResourceHashes(manifests),
        rollbackReason: rollbackReason || undefined,
      });

      await this.applicationsRepository.update(applicationId, {
        status: ApplicationStatus.RUNNING,
        currentRevisionId: revision.id,
        lastDeployedAt: new Date(),
        imageRef:
          app.imageRef ||
          (app.sourceConfig as DockerImageSourceConfig)?.imageRef,
      });

      await this.updateOperation(
        operationId,
        OperationStatus.COMPLETED,
        100,
        OperationStep.APP_DEPLOY_FINALIZE,
      );

      const finalImageRef =
        appForManifests.imageRef ||
        (appForManifests.sourceConfig as DockerImageSourceConfig)?.imageRef;
      this.eventsGateway.emitOperationCompleted(applicationId, {
        appId: applicationId,
        operationId,
        operationType: opType,
        duration: Date.now() - startedAt,
        applicationStatus: ApplicationStatus.RUNNING,
        revisionNumber,
        imageRef: finalImageRef,
        digest: this.extractDigest(finalImageRef),
        timestamp: new Date(),
      });

      this.logger.log(
        `Deploy completed for ${app.name}, revision: ${revisionNumber}`,
      );

      // For exposure=internal apps, auto-attach the InternalAppEndpoint and
      // trigger its reconciliation (Ingress with ForwardAuth + cert).
      await this.ensureInternalEndpoint(appForManifests);

      // For exposure=public apps deployed via `flui deploy` (kind: Application),
      // auto-create the public AppEndpoint based on the `flui.endpoint.spec`
      // hints stored in `app.metadata` by ApplicationSourceDeployService. This
      // is a no-op for legacy apps without that metadata key.
      if (this.applicationSourceDeployService) {
        await this.applicationSourceDeployService
          .ensurePublicEndpoint(applicationId)
          .catch((err) =>
            this.logger.warn(
              `ensurePublicEndpoint(${applicationId}) failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }

      // Trigger immediate reconciliation to confirm actual K8s state after deploy
      try {
        await this.reconciliationService.reconcileOne(applicationId);
      } catch (reconcileError) {
        // Non-blocking: reconciliation failure does not fail the deploy
        this.logger.warn(
          `Post-deploy reconciliation failed for ${app.name}: ${reconcileError.message}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Deploy failed for application ${applicationId}: ${error.message}`,
        error.stack,
      );

      await this.applicationsRepository.updateStatus(
        applicationId,
        ApplicationStatus.FAILED,
      );
      await this.updateOperation(
        operationId,
        OperationStatus.FAILED,
        undefined,
        undefined,
        error.message,
      );

      this.eventsGateway.emitOperationFailed(applicationId, {
        appId: applicationId,
        operationId,
        operationType: opType,
        error: error.message,
        attempt: job.attemptsMade,
        timestamp: new Date(),
      });
    }
  }

  private async handleSystemAppImagePatch(
    app: ApplicationEntity,
    kubeconfig: string,
    operationId: string,
    opType: OperationType,
    deployType: 'initial' | 'update' | 'rollback',
    rollbackRevisionNumber: number | undefined,
    rollbackReason: string | undefined,
    startedAt: number,
  ): Promise<void> {
    const label = app.labels?.['app'] ?? app.slug;
    const def = findSystemAppByLabel(label);
    if (!def?.imageSource) {
      throw new Error(
        `System app ${app.name} (${label}) has no imageSource configured in the catalog — cannot patch image.`,
      );
    }
    if (!app.imageRef) {
      throw new Error(
        `System app ${app.name} has no imageRef set — nothing to deploy.`,
      );
    }

    const deploymentName =
      def.imageSource.deploymentName ??
      def.expectedResources.find(
        (r) => r.kind === ApplicationResourceKind.DEPLOYMENT,
      )?.name ??
      def.k8sAppLabel;

    await this.updateOperation(
      operationId,
      OperationStatus.IN_PROGRESS,
      40,
      OperationStep.APP_DEPLOY_APPLY_MANIFESTS,
    );
    this.eventsGateway.emitOperationProgress(app.id, {
      appId: app.id,
      operationId,
      operationType: opType,
      percentage: 40,
      currentStep: 2,
      totalSteps: 3,
      message: `Patching ${deploymentName}/${def.imageSource.containerName} → ${app.imageRef}`,
      timestamp: new Date(),
    });

    await this.kubernetesService.patchDeploymentContainerImage(
      kubeconfig,
      app.k8sNamespace,
      deploymentName,
      def.imageSource.containerName,
      app.imageRef,
    );

    this.eventsGateway.emitOperationProgress(app.id, {
      appId: app.id,
      operationId,
      operationType: opType,
      percentage: 60,
      currentStep: 3,
      totalSteps: 3,
      message: `Waiting for ${deploymentName} to roll out…`,
      timestamp: new Date(),
    });
    await this.kubernetesService.waitForReady(
      kubeconfig,
      'Deployment',
      deploymentName,
      app.k8sNamespace,
      this.deployConfig.getReadinessTimeoutMs(false),
    );

    await this.updateOperation(
      operationId,
      OperationStatus.IN_PROGRESS,
      90,
      OperationStep.APP_DEPLOY_FINALIZE,
    );

    const revisionNumber =
      await this.appRevisionsRepository.getNextRevisionNumber(app.id);
    const eventType =
      deployType === 'rollback' ? AppEventType.ROLLBACK : AppEventType.DEPLOY;
    const revision = await this.appRevisionsRepository.createAuditEvent({
      applicationId: app.id,
      eventType,
      actor: { type: AppEventActorType.SYSTEM, id: 'system' },
      changeMetadata: {
        imageRef: app.imageRef,
        isInitial: deployType === 'initial',
        rollbackFromRevision: rollbackRevisionNumber ?? null,
        strategy: 'system-app-image-patch',
      },
      revisionNumber,
      imageRef: app.imageRef,
      sourceConfigSnapshot: app.sourceConfig,
      envSnapshot: app.env,
      resourcesSnapshot: app.resources,
      replicas: app.replicas,
      status: ApplicationStatus.RUNNING,
      deployedBy: 'system',
      operationId,
      k8sResourceHashes: {},
      rollbackReason: rollbackReason || undefined,
    });

    await this.applicationsRepository.update(app.id, {
      currentRevisionId: revision.id,
      lastDeployedAt: new Date(),
      imageRef: app.imageRef,
    });

    await this.updateOperation(
      operationId,
      OperationStatus.COMPLETED,
      100,
      OperationStep.APP_DEPLOY_FINALIZE,
    );

    this.eventsGateway.emitOperationCompleted(app.id, {
      appId: app.id,
      operationId,
      operationType: opType,
      duration: Date.now() - startedAt,
      applicationStatus: ApplicationStatus.RUNNING,
      revisionNumber,
      imageRef: app.imageRef,
      digest: this.extractDigest(app.imageRef),
      timestamp: new Date(),
    });

    this.logger.log(
      `System app ${app.name} image patched to ${app.imageRef}, revision ${revisionNumber}`,
    );
  }

  private async restoreFromRevision(
    app: ApplicationEntity,
    revisionNumber: number,
  ): Promise<ApplicationEntity> {
    const revision =
      await this.appRevisionsRepository.findByApplicationIdAndRevisionNumber(
        app.id,
        revisionNumber,
      );

    if (!revision) {
      throw new Error(`Revision ${revisionNumber} not found`);
    }

    // Update app with revision snapshot
    await this.applicationsRepository.update(app.id, {
      sourceConfig: revision.sourceConfigSnapshot,
      env: revision.envSnapshot,
      resources: revision.resourcesSnapshot,
      replicas: revision.replicas || app.replicas,
      imageRef: revision.imageRef,
    });

    return this.applicationsRepository.findById(app.id);
  }

  private async waitForAllReady(
    kubeconfig: string,
    app: ApplicationEntity,
    manifests: GeneratedManifest[],
  ): Promise<void> {
    const waitableKinds = new Set(['Deployment', 'StatefulSet', 'DaemonSet']);
    const hasVolumes = (app.volumes?.length ?? 0) > 0;
    const timeoutMs = this.deployConfig.getReadinessTimeoutMs(hasVolumes);

    for (const manifest of manifests) {
      if (waitableKinds.has(manifest.kind)) {
        this.logger.log(
          `Waiting for ${manifest.kind}/${manifest.name} to be ready (timeout ${timeoutMs}ms)...`,
        );
        await this.kubernetesService.waitForReady(
          kubeconfig,
          manifest.kind,
          manifest.name,
          app.k8sNamespace,
          timeoutMs,
        );

        // Update resource status to READY
        const resource = await this.appResourcesRepository.findByK8sIdentity(
          app.id,
          manifest.kind,
          manifest.name,
          app.k8sNamespace,
        );
        if (resource) {
          await this.appResourcesRepository.update(resource.id, {
            status: ApplicationResourceStatus.READY,
            reconciliationStatus: ReconciliationStatus.IN_SYNC,
            lastObservedAt: new Date(),
          });
        }
      }
    }
  }

  @Process('delete-application')
  async handleDelete(job: Job<DeleteApplicationJobData>): Promise<void> {
    const { operationId, applicationId } = job.data;
    const startedAt = Date.now();

    this.logger.log(
      `[DELETE] Processor picked up job id=${job.id} name=${job.name} attempt=${job.attemptsMade + 1} op=${operationId} app=${applicationId}`,
    );

    try {
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        0,
        OperationStep.APP_DELETE_INIT,
      );
      this.eventsGateway.emitOperationProgress(applicationId, {
        appId: applicationId,
        operationId,
        operationType: 'delete',
        percentage: 0,
        currentStep: 1,
        totalSteps: 3,
        message: 'Initializing deletion...',
        timestamp: new Date(),
      });

      const app = await this.applicationsRepository.findById(applicationId);

      // Idempotency: if app is already fully deleted, mark operation complete and exit
      if (!app) {
        this.logger.warn(
          `Application ${applicationId} not found (already deleted) — marking operation complete`,
        );
        await this.updateOperation(
          operationId,
          OperationStatus.COMPLETED,
          100,
          OperationStep.APP_DELETE_FINALIZE,
        );
        this.eventsGateway.emitOperationCompleted(applicationId, {
          appId: applicationId,
          operationId,
          operationType: 'delete',
          duration: Date.now() - startedAt,
          applicationStatus: ApplicationStatus.DELETED,
          timestamp: new Date(),
        });
        return;
      }

      const cluster = await this.clusterRepository.findOne({
        where: { id: app.clusterId },
      });
      this.logger.log(
        `[DELETE] cluster=${cluster?.id ?? 'NOT FOUND'} kubeconfigPresent=${!!cluster?.kubeconfigEncrypted}`,
      );

      // Remove K8s resources
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        30,
        OperationStep.APP_DELETE_K8S_RESOURCES,
      );
      this.eventsGateway.emitOperationProgress(applicationId, {
        appId: applicationId,
        operationId,
        operationType: 'delete',
        percentage: 30,
        currentStep: 2,
        totalSteps: 3,
        message: 'Removing Kubernetes resources...',
        timestamp: new Date(),
      });

      if (cluster?.kubeconfigEncrypted) {
        const kubeconfig = this.encryptionService.decrypt(
          cluster.kubeconfigEncrypted,
        );
        const resources =
          await this.appResourcesRepository.findByApplicationId(applicationId);
        const failedDeletes: AppResourceEntity[] = [];
        for (const resource of resources) {
          try {
            await this.kubernetesService.deleteResource(
              kubeconfig,
              resource.kind,
              resource.name,
              resource.namespace,
            );
          } catch (err) {
            this.logger.warn(
              `Failed to delete K8s resource ${resource.kind}/${resource.name}: ${err.message}`,
            );
            failedDeletes.push(resource);
          }
        }

        // Sweep finale label-based per tutti i kind che Flui crea. Cattura
        // sia i fallimenti del loop sopra (apiserver flap, transient error)
        // sia risorse create fuori dal tracking esplicito (helm hooks,
        // sidecar che monta volumi al volo). Senza questo sweep le risorse
        // restano vive nel cluster dopo che AppResourceEntity è stata
        // cancellata e Flui non sa più che esistono — fenomeno osservato nel
        // test di saturazione 2026-05-09 con Deployment, PVC e Service.
        await this.sweepOrphanResources(kubeconfig, app, failedDeletes);
      }

      await this.appResourcesRepository.deleteByApplicationId(applicationId);

      // Delete app endpoints via the reconciliation service: K8s Ingress +
      // Certificate + TLS Secret + Middleware + DNS record, then remove the
      // DB row. Reusing deleteEndpointResources ensures the DNS record is
      // freed — otherwise the host stays pointed at the cluster and future
      // re-use of the same fqdn is blocked by the unique constraint.
      try {
        const endpoints = await this.clusterRepository.manager.find(
          AppEndpointEntity,
          { where: { applicationId } },
        );
        this.logger.log(
          `[DELETE] Found ${endpoints.length} endpoint(s) for application ${applicationId}`,
        );

        if (endpoints.length > 0 && this.appEndpointReconciliationService) {
          for (const endpoint of endpoints) {
            try {
              await this.appEndpointReconciliationService.deleteEndpointResources(
                endpoint.id,
              );
            } catch (err) {
              this.logger.warn(
                `[DELETE] deleteEndpointResources failed for ${endpoint.id}: ${err.message}`,
              );
            }
            await this.clusterRepository.manager
              .remove(AppEndpointEntity, endpoint)
              .catch((err) =>
                this.logger.warn(
                  `[DELETE] endpoint DB remove failed for ${endpoint.id}: ${err.message}`,
                ),
              );
            this.logger.log(
              `[DELETE] Endpoint ${endpoint.id} (${endpoint.fqdn}) removed`,
            );
          }
        } else if (endpoints.length > 0) {
          this.logger.warn(
            `[DELETE] reconciliation service unavailable — removing endpoint DB rows only (no K8s/DNS cleanup)`,
          );
          for (const endpoint of endpoints) {
            await this.clusterRepository.manager
              .remove(AppEndpointEntity, endpoint)
              .catch(() => {});
          }
        }
      } catch (err) {
        this.logger.warn(
          `[DELETE] Failed to clean up endpoints for application ${applicationId}: ${err.message}`,
        );
      }

      // Finalize
      await this.updateOperation(
        operationId,
        OperationStatus.IN_PROGRESS,
        90,
        OperationStep.APP_DELETE_FINALIZE,
      );
      this.eventsGateway.emitOperationProgress(applicationId, {
        appId: applicationId,
        operationId,
        operationType: 'delete',
        percentage: 90,
        currentStep: 3,
        totalSteps: 3,
        message: 'Finalizing deletion...',
        timestamp: new Date(),
      });

      await this.appRevisionsRepository.createAuditEvent({
        applicationId,
        eventType: AppEventType.DELETE,
        actor: { type: AppEventActorType.SYSTEM, id: 'system' },
        changeMetadata: { clusterId: app.clusterId },
      });

      await this.applicationsRepository.softDelete(applicationId);

      // Cascade to the catalog install parent, if any. An Application owned
      // by a catalog install carries metadata.catalogInstallId; once the app
      // is gone the install row must not linger with status=RUNNING/FAILED
      // and deletedAt=NULL (we'd see phantom installs in the Catalog tab of
      // the dashboard). Idempotent: already-uninstalled rows are skipped.
      const catalogInstallId = app.metadata?.catalogInstallId;
      if (catalogInstallId) {
        try {
          await this.catalogInstallRepository.update(
            { id: catalogInstallId, deletedAt: IsNull() },
            {
              status: CatalogInstallStatus.UNINSTALLED,
              deletedAt: new Date(),
            },
          );
          this.logger.log(
            `Cascaded delete to catalog install ${catalogInstallId} (app ${applicationId})`,
          );
        } catch (err) {
          // Don't fail the app delete if the cascade update fails — the app
          // is already gone; an orphan install row is a cosmetic issue we
          // can reconcile later.
          this.logger.warn(
            `Cascade to catalog install ${catalogInstallId} failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }

      await this.updateOperation(
        operationId,
        OperationStatus.COMPLETED,
        100,
        OperationStep.APP_DELETE_FINALIZE,
      );
      this.eventsGateway.emitOperationCompleted(applicationId, {
        appId: applicationId,
        operationId,
        operationType: 'delete',
        duration: Date.now() - startedAt,
        applicationStatus: ApplicationStatus.DELETED,
        timestamp: new Date(),
      });

      this.logger.log(
        `Delete completed for application ${app.name} (${applicationId})`,
      );
    } catch (error) {
      this.logger.error(
        `Delete failed for application ${applicationId}: ${error.message}`,
        error.stack,
      );

      await this.applicationsRepository.updateStatus(
        applicationId,
        ApplicationStatus.FAILED,
      );
      await this.updateOperation(
        operationId,
        OperationStatus.FAILED,
        undefined,
        undefined,
        error.message,
      );
      this.eventsGateway.emitOperationFailed(applicationId, {
        appId: applicationId,
        operationId,
        operationType: 'delete',
        error: error.message,
        attempt: job.attemptsMade,
        timestamp: new Date(),
      });
    }
  }

  /**
   * Create or patch the ghcr.io imagePullSecret in the app's namespace so pods
   * can pull private images built by the build pipeline.
   * Returns the secret name on success, undefined on failure (non-blocking).
   */
  private async applyManifests(
    applicationId: string,
    namespace: string,
    manifests: Array<{
      yaml: string;
      kind: ApplicationResourceKind;
      name: string;
      apiVersion: string;
    }>,
    kubeconfig: string,
  ): Promise<void> {
    for (const manifest of manifests) {
      const specs = k8s.loadAllYaml(manifest.yaml);
      const specObj = (specs[0] as Record<string, unknown>) ?? {};
      const canonical =
        this.kubernetesService.buildLastAppliedConfiguration(specObj);
      const hash = crypto.createHash('sha256').update(canonical).digest('hex');
      // One row per resource: drop prior rows so the drift reconciler can't
      // re-apply a stale desiredManifest from an earlier deploy.
      await this.appResourcesRepository.deleteByK8sIdentity(
        applicationId,
        manifest.kind,
        manifest.name,
        namespace,
      );
      const resource = await this.appResourcesRepository.create({
        applicationId,
        kind: manifest.kind,
        name: manifest.name,
        namespace,
        apiVersion: manifest.apiVersion,
        status: ApplicationResourceStatus.PENDING,
        desiredHash: hash,
        desiredManifest: manifest.yaml,
        reconciliationStatus: ReconciliationStatus.PENDING,
      });
      try {
        await this.kubernetesService.applyManifest(kubeconfig, manifest.yaml);
        await this.appResourcesRepository.update(resource.id, {
          status: ApplicationResourceStatus.APPLIED,
        });
      } catch (applyErr) {
        const message =
          applyErr instanceof Error ? applyErr.message : String(applyErr);
        await this.appResourcesRepository.update(resource.id, {
          status: ApplicationResourceStatus.FAILED,
          errorMessage: message.slice(0, 4000),
        });
        throw applyErr;
      }
    }
  }

  private static readonly SWEEPABLE_KINDS: ApplicationResourceKind[] = [
    ApplicationResourceKind.DEPLOYMENT,
    ApplicationResourceKind.STATEFUL_SET,
    ApplicationResourceKind.DAEMON_SET,
    ApplicationResourceKind.SERVICE,
    ApplicationResourceKind.INGRESS,
    ApplicationResourceKind.INGRESS_ROUTE,
    ApplicationResourceKind.CONFIG_MAP,
    ApplicationResourceKind.SECRET,
    ApplicationResourceKind.PERSISTENT_VOLUME_CLAIM,
    ApplicationResourceKind.HORIZONTAL_POD_AUTOSCALER,
    ApplicationResourceKind.CERTIFICATE,
    ApplicationResourceKind.JOB,
    ApplicationResourceKind.CRON_JOB,
  ];

  private async sweepOrphanResources(
    kubeconfig: string,
    app: ApplicationEntity,
    failedFromTracking: AppResourceEntity[],
  ): Promise<void> {
    const namespace = app.k8sNamespace;
    const labelSelector = `flui-app-id=${app.id}`;

    const failedByKind = new Map<string, Set<string>>();
    for (const r of failedFromTracking) {
      if (!failedByKind.has(r.kind)) failedByKind.set(r.kind, new Set());
      failedByKind.get(r.kind).add(r.name);
    }

    let totalDeleted = 0;
    let totalFailed = 0;
    for (const kind of ApplicationDeployProcessor.SWEEPABLE_KINDS) {
      let liveNames: string[] = [];
      try {
        const items = await this.kubernetesService.listResourcesByLabel(
          kubeconfig,
          kind,
          namespace,
          labelSelector,
        );
        liveNames = items
          .map((i: any) => i?.metadata?.name as string)
          .filter((n) => !!n);
      } catch (err) {
        this.logger.warn(
          `[DELETE] sweep list ${kind} failed for app ${app.slug}: ${err.message}`,
        );
      }

      const targets = new Set<string>([
        ...(failedByKind.get(kind) ?? []),
        ...liveNames,
      ]);
      if (targets.size === 0) continue;

      for (const name of targets) {
        try {
          await this.kubernetesService.deleteResource(
            kubeconfig,
            kind,
            name,
            namespace,
          );
          totalDeleted++;
        } catch (err) {
          totalFailed++;
          this.logger.error(
            `[DELETE] sweep failed to delete ${kind}/${name} in ${namespace}: ${err.message}`,
          );
        }
      }
    }

    if (totalDeleted > 0 || totalFailed > 0) {
      this.logger.log(
        `[DELETE] sweep complete for app ${app.slug}: ${totalDeleted} deleted, ${totalFailed} failed`,
      );
    }
  }

  private async ensureGhcrPullSecret(
    kubeconfig: string,
    app: ApplicationEntity,
  ): Promise<string | undefined> {
    return this.ghcrSecretRefresh.ensureSecretForApp(kubeconfig, app);
  }

  private extractDigest(imageRef: string | null | undefined): string | null {
    if (!imageRef) return null;
    const at = imageRef.lastIndexOf('@');
    if (at < 0) return null;
    const rest = imageRef.slice(at + 1);
    return /^sha256:[0-9a-f]{64}$/.test(rest) ? rest : null;
  }

  private buildResourceHashes(
    manifests: GeneratedManifest[],
  ): Record<string, string> {
    const hashes: Record<string, string> = {};
    for (const m of manifests) {
      const hash = crypto.createHash('sha256').update(m.yaml).digest('hex');
      hashes[`${m.kind}/${m.name}`] = hash;
    }
    return hashes;
  }

  private async updateOperation(
    operationId: string,
    status: OperationStatus,
    progress?: number,
    currentStep?: OperationStep,
    errorMessage?: string,
  ): Promise<void> {
    const updateData: Partial<InfrastructureOperationEntity> = { status };
    if (progress !== undefined) updateData.progress = progress;
    if (currentStep !== undefined) updateData.currentStep = currentStep;
    if (errorMessage) updateData.errorMessage = errorMessage;
    if (status === OperationStatus.IN_PROGRESS && !updateData.startedAt) {
      updateData.startedAt = new Date();
    }
    if (
      status === OperationStatus.COMPLETED ||
      status === OperationStatus.FAILED
    ) {
      updateData.completedAt = new Date();
    }
    await this.operationRepository.update(operationId, updateData);
  }
}
