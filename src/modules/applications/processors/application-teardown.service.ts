import {
  Injectable,
  Inject,
  Logger,
  forwardRef,
  Optional,
} from '@nestjs/common';
import { Job } from 'bull';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationStep,
} from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { AppRevisionsRepository } from '../repositories/app-revisions.repository';
import { AppResourcesRepository } from '../repositories/app-resources.repository';
import { DeleteApplicationJobData } from '../services/application-deploy.service';
import { ApplicationEntity } from '../entities/application.entity';
import { ApplicationStatus } from '../enums/application-status.enum';
import { AppEventType, AppEventActorType } from '../enums/app-event-type.enum';
import { ApplicationEventsGateway } from '../gateway/application-events.gateway';
import { AppEndpointEntity } from '../../dns/entities/app-endpoint.entity'; // used via EntityManager only
import { CatalogInstallEntity } from '../../catalog/entities/catalog-install.entity';
import { CatalogInstallStatus } from '../../catalog/enums/catalog-install-status.enum';
import { AppEndpointReconciliationService } from '../../dns/services/app-endpoint-reconciliation.service';
import { ApplicationResourceKind } from '../enums/application-resource-kind.enum';
import { AppResourceEntity } from '../entities/app-resource.entity';
import { ApplicationVolumeClaimsService } from '../services/application-volume-claims.service';
import { writeOperationProgress } from './operation-progress.util';

/**
 * Everything the application queue does when an application goes away:
 * the `delete-application` job body, the label sweep that catches what the
 * tracked-resource loop missed, and the sandbox volume-claim sweep.
 *
 * Lifted out of `application-deploy.processor.ts` in round E2, which was at
 * 1383 lines. It shares no reference with the detach path — only the queue —
 * and the move is a move: no behaviour of the delete changed with it.
 */
@Injectable()
export class ApplicationTeardownService {
  private readonly logger = new Logger(ApplicationTeardownService.name);

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
    private readonly eventsGateway: ApplicationEventsGateway,
    private readonly volumeClaims: ApplicationVolumeClaimsService,
    @Optional()
    @Inject(forwardRef(() => AppEndpointReconciliationService))
    private readonly appEndpointReconciliationService?: AppEndpointReconciliationService,
  ) {}

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
        await this.sweepOrphanResources(
          kubeconfig,
          app,
          failedDeletes,
          resources,
        );
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
    trackedAtStart: AppResourceEntity[] = [],
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

    // Seeded from what was tracked *before* the loop above deleted it, not
    // from what the label listing still finds: a StatefulSet that was removed
    // successfully is no longer live and no longer failed, so reading it off
    // the sweep alone left this empty every time the delete went well — which
    // is every time that matters. The listing still adds the sets Flui never
    // recorded, so both sources are kept.
    const statefulSetNames = new Set<string>(
      trackedAtStart
        .filter((r) => r.kind === ApplicationResourceKind.STATEFUL_SET)
        .map((r) => r.name),
    );
    for (const kind of ApplicationTeardownService.SWEEPABLE_KINDS) {
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
      if (kind === ApplicationResourceKind.STATEFUL_SET) {
        for (const name of targets) statefulSetNames.add(name);
      }
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

    await this.sweepVolumeClaims(
      kubeconfig,
      app,
      statefulSetNames,
      new Set(
        trackedAtStart
          .filter(
            (r) => r.kind === ApplicationResourceKind.PERSISTENT_VOLUME_CLAIM,
          )
          .map((r) => r.name),
      ),
    );
  }

  /**
   * The claims a StatefulSet made from its `volumeClaimTemplates`.
   *
   * Kubernetes creates them, so Flui never records them as an
   * AppResourceEntity; and it labels them from the set's *selector*, which is
   * `app=<name>` and not `flui-app-id`, so the label sweep above cannot see
   * them either. Verified on the live instance — a catalog install removed
   * through the product left 10Gi bound in the tenant's namespace with nothing
   * running.
   *
   * Applies to every namespace, not only sandbox tenancies. Decision 49
   * settled that the survival of the volume was never a policy: no
   * `persistentVolumeClaimRetentionPolicy` was ever written anywhere in this
   * project, so what looked like a choice was the Kubernetes default arriving
   * unasked. Sets that Flui writes now declare `whenDeleted: Delete` on the
   * manifest and never reach here; this sweep is what catches the ones that
   * come from catalog charts, which Flui does not write.
   *
   * It is irreversible, which is why the removal preview
   * (`GET /applications/:id/removal-preview`) reads the SAME attribution: what
   * a person is told they will lose is what this then takes.
   */
  private async sweepVolumeClaims(
    kubeconfig: string,
    app: ApplicationEntity,
    statefulSetNames: Set<string>,
    trackedClaimNames: Set<string>,
  ): Promise<void> {
    if (statefulSetNames.size === 0) return;

    const claims = await this.volumeClaims.listForApplication(kubeconfig, app, {
      statefulSetNames,
      trackedNames: trackedClaimNames,
    });
    const fromTemplates = claims.filter(
      (c) => c.attributedBy === 'volume-claim-template',
    );

    for (const claim of fromTemplates) {
      try {
        await this.kubernetesService.deleteResource(
          kubeconfig,
          ApplicationResourceKind.PERSISTENT_VOLUME_CLAIM,
          claim.name,
          claim.namespace,
        );
        this.logger.log(
          `[DELETE] volume-claim sweep removed ${claim.name} (${claim.requested ?? 'size unknown'}) in ${claim.namespace}`,
        );
      } catch (err) {
        this.logger.error(
          `[DELETE] volume-claim sweep failed on ${claim.name} in ${claim.namespace}: ${err.message}`,
        );
      }
    }
  }

  private async updateOperation(
    operationId: string,
    status: OperationStatus,
    progress?: number,
    currentStep?: OperationStep,
    errorMessage?: string,
  ): Promise<void> {
    await writeOperationProgress(
      this.operationRepository,
      operationId,
      status,
      progress,
      currentStep,
      errorMessage,
    );
  }
}
