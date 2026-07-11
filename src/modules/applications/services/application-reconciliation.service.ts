import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { AppResourcesRepository } from '../repositories/app-resources.repository';
import { ApplicationManifestGeneratorService } from './application-manifest-generator.service';
import { ApplicationReleaseService } from './application-release.service';
import { ApplicationEntity } from '../entities/application.entity';
import { AppResourceEntity } from '../entities/app-resource.entity';
import { ApplicationStatus } from '../enums/application-status.enum';
import { ApplicationCategory } from '../enums/application-category.enum';
import { ApplicationResourceStatus } from '../enums/application-resource-status.enum';

type K8sResource = {
  status?: {
    readyReplicas?: number;
    unavailableReplicas?: number;
    replicas?: number;
    readyScheduledNode?: number;
    desiredNumberScheduled?: number;
    numberReady?: number;
    ready?: boolean;
    conditions?: Array<{
      type: string;
      status: string;
      message?: string;
      reason?: string;
    }>;
  };
  spec?: { replicas?: number };
};

import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';

export interface ReconciliationSummary {
  applicationId: string;
  applicationName: string;
  previousStatus: ApplicationStatus;
  newStatus: ApplicationStatus;
  driftedResources: string[];
  healedResources: string[];
  errors: string[];
}

@Injectable()
export class ApplicationReconciliationService {
  private readonly logger = new Logger(ApplicationReconciliationService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly appResourcesRepository: AppResourcesRepository,
    private readonly manifestGenerator: ApplicationManifestGeneratorService,
    private readonly releaseService: ApplicationReleaseService,
  ) {}

  /**
   * Reconcile all active applications across all clusters.
   * Can be called on-demand (e.g. from a future admin endpoint).
   */
  async reconcileAll(): Promise<void> {
    this.logger.debug(
      'Starting reconciliation cycle for all active applications',
    );

    const apps = await this.applicationsRepository.findAllActive();
    if (apps.length === 0) {
      this.logger.debug('No active applications to reconcile');
      return;
    }

    this.logger.log(`Reconciling ${apps.length} active application(s)`);

    const clusterIds = [...new Set(apps.map((a) => a.clusterId))];
    for (const clusterId of clusterIds) {
      await this.reconcileByClusterId(clusterId);
    }

    this.logger.debug('Reconciliation cycle complete');
  }

  /**
   * Reconcile all active applications in a specific cluster.
   * Queries K8s for each app's resources and updates DB status.
   */
  async reconcileByClusterId(clusterId: string): Promise<void> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });

    if (!cluster?.kubeconfigEncrypted) {
      this.logger.warn(
        `Cluster ${clusterId} has no kubeconfig, skipping refresh`,
      );
      return;
    }

    const apps =
      await this.applicationsRepository.findActiveByCluster(clusterId);
    if (apps.length === 0) {
      this.logger.debug(`No active apps in cluster ${clusterId} to reconcile`);
      return;
    }

    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );

    for (const app of apps) {
      try {
        await this.reconcileApp(app, kubeconfig);
      } catch (error) {
        const transient = this.isTransientK8sError(error);
        this.logger.error(
          `Failed to reconcile app ${app.name} (${app.id})${transient ? ' [transient]' : ''}: ${error.message}`,
        );
        await this.applicationsRepository.update(app.id, {
          reconciliationStatus: ReconciliationStatus.ERROR,
          reconciliationError: error.message,
          lastReconciliationAt: new Date(),
        });
      }
    }
  }

  private isTransientK8sError(error: unknown): boolean {
    if (!error) return false;
    const err = error as {
      code?: string;
      statusCode?: number;
      response?: { statusCode?: number };
      message?: string;
    };
    const networkCodes = new Set([
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EHOSTUNREACH',
      'ENOTFOUND',
      'ECONNRESET',
      'EAI_AGAIN',
      'EPIPE',
    ]);
    if (err.code && networkCodes.has(err.code)) return true;

    const statusCode = err.statusCode ?? err.response?.statusCode;
    if (
      statusCode === 429 ||
      statusCode === 502 ||
      statusCode === 503 ||
      statusCode === 504
    ) {
      return true;
    }

    const msg = (err.message || '').toLowerCase();
    return (
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('ehostunreach') ||
      msg.includes('econnreset') ||
      msg.includes('socket hang up') ||
      msg.includes('apiserver not ready') ||
      msg.includes('service unavailable') ||
      msg.includes('serviceunavailable')
    );
  }

  private async withK8sRetry<T>(
    fn: () => Promise<T>,
    label: string,
  ): Promise<T> {
    const delaysMs = [200, 500, 1000];
    let lastError: unknown;
    for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        if (!this.isTransientK8sError(err) || attempt === delaysMs.length) {
          throw err;
        }
        const delay = delaysMs[attempt];
        this.logger.debug(
          `Transient K8s error on ${label} (attempt ${attempt + 1}/${delaysMs.length + 1}): ${(err as Error).message} — retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw lastError;
  }

  /**
   * Reconcile a single application by ID (on-demand).
   */
  async reconcileOne(applicationId: string): Promise<ReconciliationSummary> {
    const app = await this.applicationsRepository.findById(applicationId);
    if (!app) {
      throw new Error(`Application ${applicationId} not found`);
    }

    const cluster = await this.clusterRepository.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster?.kubeconfigEncrypted) {
      throw new Error(`Cluster ${app.clusterId} missing kubeconfig`);
    }

    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );
    return this.reconcileApp(app, kubeconfig);
  }

  private async reconcileApp(
    app: ApplicationEntity,
    kubeconfig: string,
  ): Promise<ReconciliationSummary> {
    const summary: ReconciliationSummary = {
      applicationId: app.id,
      applicationName: app.name,
      previousStatus: app.status,
      newStatus: app.status,
      driftedResources: [],
      healedResources: [],
      errors: [],
    };

    // Skip reconciliation for apps that are being deleted or already soft-
    // deleted. Without this, a periodic or post-delete reconcile re-observes
    // the still-running pods, resets status to RUNNING, and overwrites the
    // delete processor's DELETING verdict — producing the flapping
    // DELETING → RUNNING → DELETING cycle on the dashboard.
    if (
      app.status === ApplicationStatus.DELETING ||
      app.status === ApplicationStatus.DELETED ||
      app.deletedAt
    ) {
      this.logger.debug(
        `App ${app.name} (${app.id}) in status=${app.status} deletedAt=${app.deletedAt?.toISOString() ?? 'null'} — skipping reconciliation`,
      );
      return summary;
    }

    const resources = await this.appResourcesRepository.findByApplicationId(
      app.id,
    );

    if (resources.length === 0) {
      this.logger.debug(`App ${app.name}: no resources to reconcile`);
      await this.applicationsRepository.update(app.id, {
        reconciliationStatus: ReconciliationStatus.IN_SYNC,
        lastReconciliationAt: new Date(),
        reconciliationError: null,
      });
      return summary;
    }

    const aggregate = await this.reconcileResources(
      app,
      resources,
      kubeconfig,
      summary,
    );
    const { allReady, anyFailed, anyDrift, transientFailures } = aggregate;

    // Transient apiserver errors (ECONNREFUSED, 503 "apiserver not ready", …)
    // must not flip the app to FAILED: we cannot observe its real state, so we
    // keep the last known status and surface the issue via reconciliationStatus
    // = ERROR + reconciliationError. Next successful cycle overwrites it.
    if (transientFailures > 0) {
      await this.applicationsRepository.update(app.id, {
        reconciliationStatus: ReconciliationStatus.ERROR,
        reconciliationError: summary.errors.join('; '),
        lastReconciliationAt: new Date(),
      });
      this.logger.warn(
        `App ${app.name}: ${transientFailures} transient K8s error(s), keeping last known status=${app.status}`,
      );
      return summary;
    }

    // Compute aggregated application status
    let newStatus: ApplicationStatus;
    let newReconciliationStatus: ReconciliationStatus;

    // Any intended resource in FAILED state → the app is NOT healthy.
    // Mapping FAILED to DEGRADED (the old behavior) silently hides broken
    // deploys: e.g. a StatefulSet that never applied (400 from K8s) leaves
    // only ConfigMap/Secret/Service tracked, all ready, and the app ends up
    // RUNNING. Treating any FAILED resource as app-level FAILED forces the
    // reconciler to preserve the deploy processor's FAILED verdict.
    if (anyFailed) {
      newStatus = ApplicationStatus.FAILED;
    } else if (allReady) {
      newStatus = ApplicationStatus.RUNNING;
    } else {
      newStatus = ApplicationStatus.DEGRADED;
    }

    if (anyDrift) {
      newReconciliationStatus = ReconciliationStatus.DRIFT;
    } else if (summary.errors.length > 0) {
      newReconciliationStatus = ReconciliationStatus.ERROR;
    } else {
      newReconciliationStatus = ReconciliationStatus.IN_SYNC;
    }

    const stuckRollout = await this.detectStuckRollout(
      app,
      resources,
      kubeconfig,
    );
    if (stuckRollout) {
      if (
        stuckRollout.availableTrue &&
        newStatus !== ApplicationStatus.RUNNING
      ) {
        newStatus = ApplicationStatus.RUNNING;
      }
      try {
        await this.releaseService.markCurrentReleaseFailed(
          app.id,
          stuckRollout.reason,
        );
      } catch (err) {
        this.logger.warn(
          `Could not mark release as FAILED for app ${app.id}: ${err.message}`,
        );
      }
    }

    summary.newStatus = newStatus;

    const healthStatus = await this.buildHealthStatus(
      app,
      resources,
      kubeconfig,
    );

    await this.applicationsRepository.update(app.id, {
      status: newStatus,
      reconciliationStatus: newReconciliationStatus,
      lastReconciliationAt: new Date(),
      reconciliationError:
        summary.errors.length > 0 ? summary.errors.join('; ') : null,
      metadata: {
        ...app.metadata,
        healthStatus: JSON.stringify(healthStatus),
      },
    });

    if (anyDrift || newStatus !== app.status) {
      this.logger.log(
        `App ${app.name}: status ${app.status} → ${newStatus}, reconciliation: ${newReconciliationStatus}`,
      );
    }

    return summary;
  }

  private async reconcileResources(
    app: ApplicationEntity,
    resources: AppResourceEntity[],
    kubeconfig: string,
    summary: ReconciliationSummary,
  ): Promise<{
    allReady: boolean;
    anyFailed: boolean;
    anyDrift: boolean;
    transientFailures: number;
  }> {
    let allReady = true;
    let anyFailed = false;
    let anyDrift = false;
    let transientFailures = 0;
    for (const resource of resources) {
      try {
        await this.reconcileResource(app, resource, kubeconfig, summary);
        const updated = await this.appResourcesRepository.findById(resource.id);
        if (updated.status === ApplicationResourceStatus.FAILED)
          anyFailed = true;
        if (updated.status !== ApplicationResourceStatus.READY)
          allReady = false;
        if (updated.reconciliationStatus === ReconciliationStatus.DRIFT)
          anyDrift = true;
      } catch (error) {
        summary.errors.push(
          `${resource.kind}/${resource.name}: ${error.message}`,
        );
        if (this.isTransientK8sError(error)) {
          transientFailures++;
          allReady = false;
          this.logger.warn(
            `Transient K8s error reconciling ${resource.kind}/${resource.name}: ${error.message}`,
          );
        } else {
          anyFailed = true;
          allReady = false;
          this.logger.error(
            `Error reconciling ${resource.kind}/${resource.name}: ${error.message}`,
          );
        }
      }
    }
    return { allReady, anyFailed, anyDrift, transientFailures };
  }

  private async reconcileResource(
    app: ApplicationEntity,
    resource: AppResourceEntity,
    kubeconfig: string,
    summary: ReconciliationSummary,
  ): Promise<void> {
    // Drift-ignored apps: still observe readiness (so the dashboard shows
    // running/degraded correctly) but suppress drift detection entirely.
    // This covers SYSTEM-category apps, whose manifests are owned by the
    // bootstrap script / Helm rather than Flui, and any app whose operator
    // explicitly opted out via metadata.driftPolicy = 'ignore'.
    const driftIgnored = this.isDriftIgnored(app);

    // 1. Fetch actual state from K8s
    const actual = await this.withK8sRetry(
      () =>
        this.kubernetesService.getResource(
          kubeconfig,
          resource.kind,
          resource.name,
          resource.namespace,
        ),
      `${resource.kind}/${resource.name}`,
    );

    if (!actual) {
      // Resource missing from K8s
      this.logger.warn(
        `Resource ${resource.kind}/${resource.name} not found on K8s for app ${app.name}`,
      );
      await this.appResourcesRepository.update(resource.id, {
        status: ApplicationResourceStatus.FAILED,
        reconciliationStatus: driftIgnored
          ? ReconciliationStatus.IN_SYNC
          : ReconciliationStatus.DRIFT,
        errorMessage: 'Resource not found on Kubernetes',
        lastObservedAt: new Date(),
      });

      if (!driftIgnored) {
        summary.driftedResources.push(
          `${resource.kind}/${resource.name} (missing)`,
        );
        // Auto-heal: re-apply if desired manifest available
        await this.tryAutoHeal(app, resource, kubeconfig, summary);
      }
      return;
    }

    // 2. Compute actual hash from the last-applied-configuration annotation.
    // That annotation holds the exact byte-for-byte JSON string written by
    // KubernetesService.applyManifest (via buildLastAppliedConfiguration), and
    // desiredHash is sha256 of the same helper output — so when Flui owns the
    // resource, the two hashes are directly comparable.
    //
    // If the annotation is missing we deliberately DO NOT fall back to hashing
    // `actual.spec`: K8s mutates spec on write (clusterIP, ipFamilyPolicy,
    // sessionAffinity, targetPort normalization, progressDeadlineSeconds, …)
    // so a spec-level hash against the stored desiredHash is guaranteed to
    // diverge and would produce permanent false-positive drift.
    const lastApplied =
      actual.metadata?.annotations?.[
        'kubectl.kubernetes.io/last-applied-configuration'
      ];
    const actualHash = lastApplied
      ? crypto.createHash('sha256').update(lastApplied).digest('hex')
      : null;

    // 3. Get resourceVersion for tracking
    const resourceVersion = actual.metadata?.resourceVersion || '';

    // 4. Determine readiness
    const resourceStatus = this.computeResourceStatus(resource.kind, actual);

    // 5. Detect drift: compare actualHash vs desiredHash (unless ignored).
    // When actualHash is null (annotation missing) we cannot verify drift
    // reliably, so we report IN_SYNC and log at debug level — better to miss
    // a real drift than to cry wolf on every reconcile cycle.
    let reconciliationStatus = ReconciliationStatus.IN_SYNC;
    if (!driftIgnored && resource.desiredHash) {
      if (actualHash === null) {
        this.logger.debug(
          `Skipping drift check for ${resource.kind}/${resource.name} in app ${app.name}: last-applied-configuration annotation missing`,
        );
      } else if (actualHash !== resource.desiredHash) {
        reconciliationStatus = ReconciliationStatus.DRIFT;
        summary.driftedResources.push(`${resource.kind}/${resource.name}`);

        this.logger.warn(
          `DRIFT detected: ${resource.kind}/${resource.name} in app ${app.name}`,
        );
      }
    }

    // 6. Compute condition message for workload resources
    const conditionMessage =
      (resource.kind === 'Deployment' || resource.kind === 'StatefulSet') &&
      resourceStatus === ApplicationResourceStatus.DEGRADED
        ? this.extractConditionMessage(actual)
        : null;

    await this.recordObservedImage(app, resource.kind, actual);

    // 7. Update AppResourceEntity — only overwrite actualHash when we could
    // actually compute one. If the annotation was missing we leave the
    // previously stored value alone rather than nuking it to NULL.
    const updatePayload: Partial<AppResourceEntity> = {
      status: resourceStatus,
      lastObservedAt: new Date(),
      errorMessage: conditionMessage,
      reconciliationStatus,
      metadata: {
        ...resource.metadata,
        resourceVersion,
      },
    };
    if (actualHash !== null) {
      updatePayload.actualHash = actualHash;
    }
    await this.appResourcesRepository.update(resource.id, updatePayload);

    // 8. Auto-heal if DRIFT and policy allows
    if (!driftIgnored && reconciliationStatus === ReconciliationStatus.DRIFT) {
      await this.tryAutoHeal(app, resource, kubeconfig, summary);
    }
  }

  /**
   * The reconciler owns observed state: record the live primary-container image
   * on the app (only on change) so desired (app.imageRef) != observed drives
   * convergence and the dashboard reflects what is actually running.
   */
  private async recordObservedImage(
    app: ApplicationEntity,
    kind: string,
    actual: unknown,
  ): Promise<void> {
    if (kind !== 'Deployment' && kind !== 'StatefulSet') return;
    const liveImage = (
      actual as {
        spec?: {
          template?: { spec?: { containers?: Array<{ image?: string }> } };
        };
      }
    ).spec?.template?.spec?.containers?.[0]?.image;
    if (liveImage && liveImage !== app.observedImageRef) {
      await this.applicationsRepository.update(app.id, {
        observedImageRef: liveImage,
      });
    }
  }

  /**
   * Returns true when drift detection should be suppressed for this app.
   *
   * Covers two cases:
   * 1. SYSTEM category — these apps are deployed out-of-band (bootstrap scripts,
   *    Helm) and their manifests are not owned by Flui. Marked system-wide
   *    regardless of stored driftPolicy so legacy rows registered before this
   *    change keep working without a DB migration.
   * 2. Any app that explicitly opted out via metadata.driftPolicy = 'ignore'.
   */
  private isDriftIgnored(app: ApplicationEntity): boolean {
    if (app.category === ApplicationCategory.SYSTEM) return true;
    const policy = app.metadata?.['driftPolicy'];
    return policy === 'ignore';
  }

  private async tryAutoHeal(
    app: ApplicationEntity,
    resource: AppResourceEntity,
    kubeconfig: string,
    summary: ReconciliationSummary,
  ): Promise<void> {
    const driftPolicy = app.metadata?.['driftPolicy'] || 'alert';

    if (driftPolicy !== 'auto_heal') {
      this.logger.debug(
        `App ${app.name} drift policy is "${driftPolicy}", skipping auto-heal`,
      );
      return;
    }

    if (!resource.desiredManifest) {
      this.logger.warn(
        `Cannot auto-heal ${resource.kind}/${resource.name}: no desiredManifest stored`,
      );
      return;
    }

    try {
      this.logger.log(
        `Auto-healing ${resource.kind}/${resource.name} for app ${app.name}`,
      );
      await this.kubernetesService.applyManifest(
        kubeconfig,
        resource.desiredManifest,
      );

      await this.appResourcesRepository.update(resource.id, {
        reconciliationStatus: ReconciliationStatus.RECONCILING,
        errorMessage: null,
      });

      summary.healedResources.push(`${resource.kind}/${resource.name}`);
    } catch (error) {
      this.logger.error(
        `Auto-heal failed for ${resource.kind}/${resource.name}: ${error.message}`,
      );
      await this.appResourcesRepository.update(resource.id, {
        reconciliationStatus: ReconciliationStatus.ERROR,
        errorMessage: `Auto-heal failed: ${error.message}`,
      });
    }
  }

  private computeResourceStatus(
    kind: string,
    resource: K8sResource,
  ): ApplicationResourceStatus {
    switch (kind) {
      case 'Deployment':
      case 'StatefulSet': {
        const ready = resource.status?.readyReplicas || 0;
        const unavailable = resource.status?.unavailableReplicas || 0;
        const desired =
          resource.status?.replicas || resource.spec?.replicas || 1;
        if (ready === 0 || unavailable > 0)
          return ApplicationResourceStatus.DEGRADED;
        if (ready < desired) return ApplicationResourceStatus.DEGRADED;
        return ApplicationResourceStatus.READY;
      }
      case 'DaemonSet': {
        const ready = resource.status?.numberReady || 0;
        const desired = resource.status?.desiredNumberScheduled || 0;
        if (desired === 0) return ApplicationResourceStatus.READY;
        return ready >= desired
          ? ApplicationResourceStatus.READY
          : ApplicationResourceStatus.DEGRADED;
      }
      case 'Service':
      case 'ConfigMap':
      case 'Secret':
      case 'PersistentVolumeClaim':
        return ApplicationResourceStatus.READY;
      default:
        return ApplicationResourceStatus.APPLIED;
    }
  }

  /**
   * Inspects the primary workload's conditions to detect a rollout that has
   * exceeded its progress deadline (`Progressing=False` with reason
   * `ProgressDeadlineExceeded` — also matches the human-readable variant
   * "...has timed out progressing."). Returns the failure reason and
   * whether the workload is still Available — i.e. the previous ReplicaSet
   * is still serving traffic so the application is functionally healthy
   * even if the latest release failed.
   */
  private async detectStuckRollout(
    app: ApplicationEntity,
    resources: AppResourceEntity[],
    kubeconfig: string,
  ): Promise<{ reason: string; availableTrue: boolean } | null> {
    const primaryWorkload = resources.find(
      (r) => r.kind === 'Deployment' || r.kind === 'StatefulSet',
    );
    if (!primaryWorkload) return null;

    let actual: K8sResource | null = null;
    try {
      actual = await this.kubernetesService.getResource(
        kubeconfig,
        primaryWorkload.kind,
        primaryWorkload.name,
        primaryWorkload.namespace,
      );
    } catch {
      return null;
    }
    const conditions = actual?.status?.conditions ?? [];
    const progressing = conditions.find((c) => c.type === 'Progressing');
    const stuck =
      progressing?.status === 'False' &&
      (progressing.reason === 'ProgressDeadlineExceeded' ||
        /timed out progressing/i.test(progressing.message ?? ''));
    if (!stuck) return null;
    const available = conditions.find((c) => c.type === 'Available');
    return {
      reason:
        progressing.message ||
        progressing.reason ||
        'Rollout exceeded progress deadline',
      availableTrue: available?.status === 'True',
    };
  }

  /**
   * Extracts a human-readable condition message from a Deployment/StatefulSet resource.
   * Looks for the most relevant non-ok condition (Available=False, Progressing with reason).
   */
  private extractConditionMessage(resource: K8sResource): string | null {
    const conditions = resource?.status?.conditions || [];
    const available = conditions.find((c) => c.type === 'Available');
    if (available?.status === 'False' && available.message) {
      return available.message;
    }
    const progressing = conditions.find((c) => c.type === 'Progressing');
    if (
      progressing?.reason &&
      progressing.reason !== 'NewReplicaSetAvailable'
    ) {
      return progressing.message || progressing.reason;
    }
    return null;
  }

  /**
   * Builds the healthStatus metadata object written to ApplicationEntity.
   * Fetches the primary workload (Deployment/StatefulSet) from K8s to extract
   * readyReplicas, unavailableReplicas, and condition messages.
   */
  private async buildHealthStatus(
    app: ApplicationEntity,
    resources: AppResourceEntity[],
    kubeconfig: string,
  ): Promise<Record<string, unknown>> {
    const primaryWorkload = resources.find(
      (r) => r.kind === 'Deployment' || r.kind === 'StatefulSet',
    );

    if (!primaryWorkload) {
      return { healthy: false, checkedAt: new Date().toISOString() };
    }

    let readyPods: number | null = null;
    let totalPods: number | null = null;
    let unavailablePods: number | null = null;
    let conditionMessage: string | null = null;

    try {
      const actual = await this.withK8sRetry(
        () =>
          this.kubernetesService.getResource(
            kubeconfig,
            primaryWorkload.kind,
            primaryWorkload.name,
            primaryWorkload.namespace,
          ),
        `health:${primaryWorkload.kind}/${primaryWorkload.name}`,
      );

      if (actual) {
        readyPods = actual.status?.readyReplicas ?? 0;
        totalPods = actual.status?.replicas ?? actual.spec?.replicas ?? 1;
        unavailablePods = actual.status?.unavailableReplicas ?? 0;
        conditionMessage = this.extractConditionMessage(actual);
      }
    } catch {
      // Non-fatal: health status will be partial
    }

    return {
      readyPods,
      totalPods,
      unavailablePods,
      conditionMessage,
      checkedAt: new Date().toISOString(),
    };
  }
}
