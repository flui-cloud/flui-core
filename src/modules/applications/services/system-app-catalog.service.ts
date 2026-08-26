import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as crypto from 'node:crypto';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { ApplicationEntity } from '../entities/application.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { AppResourcesRepository } from '../repositories/app-resources.repository';
import { RawManifestSourceConfig } from '../interfaces/source-config.interface';
import {
  SYSTEM_APP_CATALOG,
  SystemAppDefinition,
} from '../constants/system-app-catalog';
import {
  OWNER_KIND_LABEL,
  readDeclaredProvenance,
} from '../constants/app-provenance';
import {
  FLUI_CONTROL_NAMESPACE,
  FLUI_LEGACY_CONTROL_NAMESPACE,
} from '../../infrastructure/clusters/constants';
import { ApplicationResourceKind } from '../enums/application-resource-kind.enum';
import { ApplicationCategory } from '../enums/application-category.enum';
import { ApplicationKind } from '../enums/application-kind.enum';
import { ApplicationStatus } from '../enums/application-status.enum';
import { ApplicationExposure } from '../enums/application-exposure.enum';
import { ApplicationResourceStatus } from '../enums/application-resource-status.enum';
import { ReconciliationStatus } from '../../infrastructure/shared/enums/reconciliation-status.enum';

export interface DiscoveryResult {
  discovered: Array<{ name: string; id: string; resourceCount: number }>;
  skipped: Array<{ name: string; reason: string }>;
  errors: Array<{ name: string; error: string }>;
}

@Injectable()
export class SystemAppCatalogService {
  private readonly logger = new Logger(SystemAppCatalogService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly appResourcesRepository: AppResourcesRepository,
  ) {}

  getCatalogForClusterType(clusterType: string): SystemAppDefinition[] {
    // 'control' is the renamed 'observability'; the catalog still uses the old name.
    const legacyType =
      clusterType === 'control' ? 'observability' : clusterType;
    return SYSTEM_APP_CATALOG.filter((def) =>
      def.clusterTypes.includes(legacyType as 'observability' | 'workload'),
    );
  }

  async discoverSystemApps(clusterId: string): Promise<DiscoveryResult> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }
    if (!cluster.kubeconfigEncrypted) {
      throw new NotFoundException(`Cluster ${clusterId} has no kubeconfig`);
    }

    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );
    const catalog = this.getCatalogForClusterType(cluster.clusterType);

    const result: DiscoveryResult = {
      discovered: [],
      skipped: [],
      errors: [],
    };

    // Check if apps already exist for this cluster
    const existingApps =
      await this.applicationsRepository.findByClusterIdAndCategory(
        clusterId,
        ApplicationCategory.SYSTEM,
      );
    const existingByLabel = new Map(
      existingApps.map((a) => [a.labels?.['app'] || a.slug, a] as const),
    );

    for (const catalogDef of catalog) {
      try {
        const appDef = await this.resolveAppNamespace(kubeconfig, catalogDef);

        // Read before the already-exists branch, not after it. The declaration
        // this row needs lives on the cluster, and rows written before the
        // columns existed carry nothing — so the resource has to be fetched on
        // every pass, not only on the pass that creates the row. This is what
        // makes convergence the migration: no backfill guesses which slugs are
        // the platform's, the cluster says so on each run.
        const primaryResource = await this.findResourceOnK8s(
          kubeconfig,
          appDef.primaryResourceKind,
          appDef.expectedResources.find(
            (r) => r.kind === appDef.primaryResourceKind,
          )?.name || appDef.k8sAppLabel,
          appDef.k8sNamespace,
        );

        const existing = existingByLabel.get(appDef.k8sAppLabel);
        if (existing) {
          if (appDef.imageSource) {
            await this.refreshSystemAppImageRef(
              kubeconfig,
              existing.id,
              appDef,
            );
          }
          await this.convergeExposure(existing, appDef);
          await this.convergeProvenance(existing, primaryResource);
          result.skipped.push({
            name: appDef.name,
            reason: 'Already exists in database (imageRef refreshed)',
          });
          continue;
        }

        if (!primaryResource) {
          result.skipped.push({
            name: appDef.name,
            reason: 'Primary resource not found on K8s',
          });
          continue;
        }

        const provenance = readDeclaredProvenance(primaryResource);
        if (!provenance.ownerKind) {
          this.logger.warn(
            `${appDef.name} declares no ${OWNER_KIND_LABEL} on ` +
              `${appDef.primaryResourceKind}/${appDef.k8sAppLabel} in ${appDef.k8sNamespace}: ` +
              'the row is recorded without provenance and reads as unattributed.',
          );
        }

        const slug = appDef.k8sAppLabel;

        // Resolve port from K8s Service if available
        const serviceResource = await this.findResourceOnK8s(
          kubeconfig,
          'Service',
          appDef.k8sAppLabel,
          appDef.k8sNamespace,
        );
        const resolvedPort: number | null =
          serviceResource?.spec?.ports?.[0]?.targetPort ||
          serviceResource?.spec?.ports?.[0]?.port ||
          appDef.port ||
          null;

        const app = await this.applicationsRepository.create({
          name: appDef.name,
          slug,
          description: appDef.description,
          category: ApplicationCategory.SYSTEM,
          kind: ApplicationKind.SYSTEM,
          sourceType: appDef.sourceType,
          clusterId,
          k8sNamespace: appDef.k8sNamespace,
          port: resolvedPort,
          status: ApplicationStatus.RUNNING,
          exposure: appDef.exposure ?? ApplicationExposure.CLUSTER,
          reconciliationStatus: ReconciliationStatus.IN_SYNC,
          lastReconciliationAt: new Date(),
          sourceConfig: {
            type: 'raw_manifest',
            manifests: [],
          } as RawManifestSourceConfig,
          systemProtected: true,
          ownerKind: provenance.ownerKind,
          ownerRef: provenance.ownerRef,
          labels: {
            app: appDef.k8sAppLabel,
            'app.kubernetes.io/managed-by': 'flui-cloud',
          },
          // System apps are deployed out-of-band (bootstrap scripts / Helm), so Flui
          // does not own their manifests. Drift is expected and auto-heal is impossible
          // because no desiredManifest is stored during discovery — we observe readiness
          // but suppress drift alerts. Policy can be overridden later per-app if needed.
          metadata: { driftPolicy: 'ignore' },
        });

        // Discover the current container image for system apps with a known
        // image source. Populates app.imageRef so the versioning UI can show
        // "currently deployed" against the registry tag list.
        if (appDef.imageSource) {
          await this.refreshSystemAppImageRef(kubeconfig, app.id, appDef);
        }

        const resourceCount = await this.discoverExpectedResources(
          kubeconfig,
          app.id,
          appDef,
        );

        result.discovered.push({
          name: appDef.name,
          id: app.id,
          resourceCount,
        });

        this.logger.log(
          `Discovered system app: ${appDef.name} (${app.id}) with ${resourceCount} resources`,
        );
      } catch (error) {
        result.errors.push({
          name: catalogDef.name,
          error: error.message,
        });
        this.logger.error(
          `Failed to discover ${catalogDef.name}: ${error.message}`,
          error.stack,
        );
      }
    }

    return result;
  }

  /**
   * The observability stack moved namespaces in the control rename. For its apps,
   * use whichever of the new/legacy namespace actually holds the resource.
   */
  private async resolveAppNamespace(
    kubeconfig: string,
    appDef: SystemAppDefinition,
  ): Promise<SystemAppDefinition> {
    const ns = appDef.k8sNamespace;
    if (ns !== FLUI_CONTROL_NAMESPACE && ns !== FLUI_LEGACY_CONTROL_NAMESPACE) {
      return appDef;
    }
    const primaryName =
      appDef.expectedResources.find(
        (r) => r.kind === appDef.primaryResourceKind,
      )?.name || appDef.k8sAppLabel;
    for (const candidate of [
      FLUI_CONTROL_NAMESPACE,
      FLUI_LEGACY_CONTROL_NAMESPACE,
    ]) {
      const found = await this.findResourceOnK8s(
        kubeconfig,
        appDef.primaryResourceKind,
        primaryName,
        candidate,
      );
      if (found) {
        return candidate === ns
          ? appDef
          : { ...appDef, k8sNamespace: candidate };
      }
    }
    return appDef;
  }

  private async discoverExpectedResources(
    kubeconfig: string,
    appId: string,
    appDef: SystemAppDefinition,
  ): Promise<number> {
    let resourceCount = 0;
    for (const expectedRes of appDef.expectedResources) {
      const k8sResource = await this.findResourceOnK8s(
        kubeconfig,
        expectedRes.kind,
        expectedRes.name,
        appDef.k8sNamespace,
      );
      if (!k8sResource) continue;

      const manifestJson = JSON.stringify(k8sResource);
      const hash = crypto
        .createHash('sha256')
        .update(manifestJson)
        .digest('hex');

      const appResource = await this.appResourcesRepository.create({
        applicationId: appId,
        kind: expectedRes.kind,
        name: expectedRes.name,
        namespace: appDef.k8sNamespace,
        apiVersion: expectedRes.apiVersion,
        status: ApplicationResourceStatus.READY,
        desiredHash: hash,
        actualHash: hash,
        reconciliationStatus: ReconciliationStatus.IN_SYNC,
        lastObservedAt: new Date(),
        metadata: {
          resourceVersion: k8sResource.metadata?.resourceVersion || '',
        },
      });

      await this.patchK8sResourceLabels(
        kubeconfig,
        expectedRes.kind,
        expectedRes.name,
        appDef.k8sNamespace,
        expectedRes.apiVersion,
        appId,
        appResource.id,
      );

      resourceCount++;
    }
    return resourceCount;
  }

  /**
   * Bring an already-discovered system app in line with its declared exposure.
   *
   * Clusters discovered before exposure was declared stored the entity default,
   * `public`, for every system app — reporting their own Postgres and Redis as
   * internet-facing on a host whose firewall drops every port they could be
   * reached on. Converging here rather than in a migration keeps discovery the
   * single owner of these rows, and it runs on every cluster.
   */
  private async convergeExposure(
    existing: ApplicationEntity,
    appDef: SystemAppDefinition,
  ): Promise<void> {
    const declared = appDef.exposure ?? ApplicationExposure.CLUSTER;
    if (existing.exposure === declared) return;
    await this.applicationsRepository.update(existing.id, {
      exposure: declared,
    });
  }

  /**
   * Bring an already-discovered row in line with what the cluster declares.
   *
   * Silence is not a denial: a resource that could not be read, or that carries
   * no `owner-kind`, leaves whatever the row already holds. Overwriting a good
   * provenance with a blank because one API call missed would make discovery a
   * source of the very absence it is here to remove.
   */
  private async convergeProvenance(
    existing: ApplicationEntity,
    primaryResource: unknown,
  ): Promise<void> {
    if (!primaryResource) return;
    const declared = readDeclaredProvenance(primaryResource);
    if (!declared.ownerKind) return;
    if (
      existing.ownerKind === declared.ownerKind &&
      (existing.ownerRef ?? null) === declared.ownerRef
    ) {
      return;
    }
    await this.applicationsRepository.update(existing.id, {
      ownerKind: declared.ownerKind,
      ownerRef: declared.ownerRef,
    });
    this.logger.log(
      `Converged provenance for ${existing.slug}: ownerKind=${declared.ownerKind} ownerRef=${declared.ownerRef ?? 'null'}`,
    );
  }

  private async refreshSystemAppImageRef(
    kubeconfig: string,
    appId: string,
    appDef: SystemAppDefinition,
  ): Promise<void> {
    if (!appDef.imageSource) return;
    const deploymentName =
      appDef.imageSource.deploymentName ??
      appDef.expectedResources.find(
        (r) => r.kind === ApplicationResourceKind.DEPLOYMENT,
      )?.name ??
      appDef.k8sAppLabel;
    try {
      const currentImage =
        await this.kubernetesService.getDeploymentContainerImage(
          kubeconfig,
          appDef.k8sNamespace,
          deploymentName,
          appDef.imageSource.containerName,
        );
      if (currentImage) {
        await this.applicationsRepository.update(appId, {
          imageRef: currentImage,
        });
      }
    } catch (err) {
      this.logger.warn(
        `Failed to refresh imageRef for ${appDef.name}: ${(err as Error).message}`,
      );
    }
  }

  private async findResourceOnK8s(
    kubeconfig: string,
    kind: string,
    name: string,
    namespace: string,
  ): Promise<any | null> {
    try {
      return await this.kubernetesService.getResource(
        kubeconfig,
        kind,
        name,
        namespace,
      );
    } catch (error) {
      if (error.statusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  private async patchK8sResourceLabels(
    kubeconfig: string,
    kind: string,
    name: string,
    namespace: string,
    apiVersion: string,
    appId: string,
    resourceId: string,
  ): Promise<void> {
    try {
      const patchManifest = JSON.stringify({
        apiVersion,
        kind,
        metadata: {
          name,
          namespace,
          labels: {
            'app.kubernetes.io/managed-by': 'flui-cloud',
            'flui-app-id': appId,
            'flui.cloud/app-kind': ApplicationKind.SYSTEM,
          },
          annotations: {
            'flui.cloud/resource-id': resourceId,
          },
        },
      });

      await this.kubernetesService.applyManifest(kubeconfig, patchManifest);
      this.logger.debug(
        `Patched labels on ${kind}/${name}: flui-app-id=${appId}`,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to patch labels on ${kind}/${name}: ${error.message}`,
      );
    }
  }
}
