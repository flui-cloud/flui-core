import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { VolumeExportService } from '../../providers/services/volume-export.service';
import {
  ExportResult,
  ExportSummary,
  IVolumeExport,
  VolumeExportCapabilities,
} from '../../providers/interfaces/volume-export.interface';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { AppResourcesRepository } from '../repositories/app-resources.repository';
import { ApplicationResourceKind } from '../enums/application-resource-kind.enum';
import { AppOperationRunner } from './app-operation-runner.service';
import { OperationType } from '../../infrastructure/servers/entities/infrastructure-operations.entity';
import {
  SnapshotCapability,
  SnapshotStorageCapabilityService,
} from './snapshot-storage-capability.service';

export interface CreateSnapshotForAppRequest {
  applicationId: string;
  /** Who asked. Recorded on the operation so its owner can follow it. */
  userId?: string;
  /** Optional PVC name. If omitted and the app has exactly one PVC, that one is used. */
  volumeName?: string;
  /** Optional human-friendly suffix appended to the generated snapshot id. */
  description?: string;
}

export interface SnapshotResponse extends ExportSummary {
  provider: CloudProvider;
  providerCapabilities: VolumeExportCapabilities;
}

export interface SnapshotListResponse extends SnapshotCapability {
  items: SnapshotResponse[];
}

@Injectable()
export class VolumeSnapshotsService {
  private readonly logger = new Logger(VolumeSnapshotsService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly applicationsRepository: ApplicationsRepository,
    private readonly appResourcesRepository: AppResourcesRepository,
    private readonly volumeExportService: VolumeExportService,
    private readonly snapshotStorageCapability: SnapshotStorageCapabilityService,
    private readonly encryptionService: EncryptionService,
    private readonly runner: AppOperationRunner,
  ) {}

  async createForApp(
    request: CreateSnapshotForAppRequest,
  ): Promise<SnapshotResponse & { operationId: string }> {
    const { app, cluster, kubeconfig, ops, provider } =
      await this.resolveAppContext(request.applicationId);
    const pvcName = await this.resolvePvcName(app.id, request.volumeName);
    await this.requireSnapshotCapability(app, kubeconfig, [pvcName]);

    const { result, operationId } = await this.runner.run(
      {
        appId: app.id,
        operationType: OperationType.APP_SNAPSHOT_CREATE,
        resourceName: app.slug,
        userId: request.userId,
        metadata: { pvcName, description: request.description },
      },
      async (): Promise<SnapshotResponse> => {
        const snapshotName = this.buildSnapshotName(
          app.slug,
          request.description,
        );
        const baseLabels: Record<string, string> = {
          'flui.cloud/managed-by': 'flui-cloud',
          'flui-app-id': app.id,
          'flui.cloud/source-pvc': pvcName,
          'flui.cloud/snapshot-trigger': 'manual',
        };
        const exp: ExportResult = await ops.createExport({
          sink: 'pvc-clone',
          kubeconfig,
          namespace: app.k8sNamespace,
          sourcePvcName: pvcName,
          exportName: snapshotName,
          labels: baseLabels,
        });
        this.logger.log(
          `[snapshot] Created ${exp.sink} ${exp.exportId} for app=${app.slug} cluster=${cluster.id} (provider=${provider})`,
        );
        return {
          exportId: exp.exportId,
          sink: exp.sink,
          namespace: exp.namespace,
          sourcePvcName: pvcName,
          appId: app.id,
          sizeGb: exp.sourceSizeGb,
          actualBytes: exp.actualBytes,
          createdAt: exp.createdAt,
          ready: exp.ready,
          labels: baseLabels,
          provider,
          providerCapabilities: ops.capabilities,
        };
      },
    );
    return { ...result, operationId };
  }

  async listForApp(applicationId: string): Promise<SnapshotListResponse> {
    const { app, kubeconfig, ops, provider } =
      await this.resolveAppContext(applicationId);
    const pvcNames = await this.resolvePvcNames(app.id);
    const capability = await this.getSnapshotCapability(
      app,
      kubeconfig,
      pvcNames,
    );
    if (!capability.supported) {
      return { ...capability, items: [] };
    }

    const items = await ops.listExports({
      kubeconfig,
      sink: 'pvc-clone',
      namespace: app.k8sNamespace,
      labelSelector: `flui-app-id=${app.id}`,
    });
    return {
      supported: true,
      items: items.map((s) => ({
        ...s,
        provider,
        providerCapabilities: ops.capabilities,
      })),
    };
  }

  async listForCluster(clusterId: string): Promise<SnapshotResponse[]> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);
    if (!cluster.kubeconfigEncrypted) {
      throw new BadRequestException(
        `Cluster ${clusterId} has no kubeconfig — cannot list snapshots`,
      );
    }
    const provider = cluster.provider as CloudProvider;
    const ops = this.volumeExportService;
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );

    const apps = await this.applicationsRepository.findActiveByCluster(
      cluster.id,
    );
    const namespaces = Array.from(
      new Set(apps.map((a) => a.k8sNamespace).filter(Boolean)),
    );

    const all: ExportSummary[] = [];
    for (const namespace of namespaces) {
      try {
        const items = await ops.listExports({
          kubeconfig,
          sink: 'pvc-clone',
          namespace,
          labelSelector: 'flui.cloud/managed-by=flui-cloud',
        });
        all.push(...items);
      } catch (err: any) {
        this.logger.warn(
          `[snapshot] cluster-wide list — failed for ns=${namespace}: ${err.message}`,
        );
      }
    }

    return all.map((s) => ({
      ...s,
      provider,
      providerCapabilities: ops.capabilities,
    }));
  }

  async restoreForApp(
    applicationId: string,
    snapshotId: string,
    userId?: string,
  ): Promise<{
    newPvcName: string;
    sourceSnapshotId: string;
    operationId: string;
  }> {
    const { app, kubeconfig, ops } =
      await this.resolveAppContext(applicationId);

    const existing = await ops.listExports({
      kubeconfig,
      sink: 'pvc-clone',
      namespace: app.k8sNamespace,
      labelSelector: `flui-app-id=${app.id}`,
    });
    const source = existing.find((s) => s.exportId === snapshotId);
    if (!source) {
      throw new NotFoundException(
        `Snapshot ${snapshotId} not found for app ${applicationId}`,
      );
    }
    if (!source.ready) {
      throw new BadRequestException(
        `Snapshot ${snapshotId} is not ready yet — wait for the copy job to finish`,
      );
    }
    const sourcePvcNames = source.sourcePvcName
      ? [source.sourcePvcName]
      : await this.resolvePvcNames(app.id);
    await this.requireSnapshotCapability(app, kubeconfig, sourcePvcNames);

    const pvcs = await this.appResourcesRepository.findByApplicationId(app.id);
    const dataPvc = pvcs.find(
      (r) =>
        r.kind === ApplicationResourceKind.PERSISTENT_VOLUME_CLAIM &&
        r.name === source.sourcePvcName,
    );
    const storageClass =
      (dataPvc?.metadata as { storageClassName?: string } | undefined)
        ?.storageClassName ?? 'local-path';
    const ts = new Date().toISOString().replaceAll(/[-:T]/g, '').slice(0, 14);
    const naturalName = `${source.sourcePvcName ?? app.slug}-restored-${ts}`;
    const newPvcName = naturalName.slice(0, 63);

    const { operationId } = await this.runner.run(
      {
        appId: app.id,
        operationType: OperationType.APP_SNAPSHOT_RESTORE,
        resourceName: app.slug,
        userId,
        metadata: { snapshotId, newPvcName },
      },
      async () => {
        await ops.restoreFromExport({
          kubeconfig,
          namespace: app.k8sNamespace,
          exportId: snapshotId,
          sink: 'pvc-clone',
          newPvcName,
          storageClassName: storageClass,
          sizeGb: source.sizeGb ?? 1,
          labels: {
            'flui.cloud/managed-by': 'flui-cloud',
            'flui-app-id': app.id,
            'flui.cloud/restored-from': snapshotId,
          },
        });
        this.logger.log(
          `[restore] Created PVC ${newPvcName} from snapshot ${snapshotId} for app=${app.slug}`,
        );
        return { newPvcName, sourceSnapshotId: snapshotId };
      },
    );
    return { newPvcName, sourceSnapshotId: snapshotId, operationId };
  }

  async deleteForApp(
    applicationId: string,
    snapshotId: string,
    userId?: string,
  ): Promise<{ operationId: string }> {
    const { app, kubeconfig, ops } =
      await this.resolveAppContext(applicationId);
    const pvcNames = await this.resolvePvcNames(app.id);
    await this.requireSnapshotCapability(app, kubeconfig, pvcNames);
    const { operationId } = await this.runner.run(
      {
        appId: app.id,
        operationType: OperationType.APP_SNAPSHOT_DELETE,
        resourceName: app.slug,
        userId,
        metadata: { snapshotId },
      },
      async () => {
        await ops.deleteExport({
          kubeconfig,
          sink: 'pvc-clone',
          namespace: app.k8sNamespace,
          exportId: snapshotId,
          ignoreNotFound: true,
        });
        this.logger.log(`[snapshot] Deleted ${snapshotId} for app=${app.slug}`);
      },
    );
    return { operationId };
  }

  private async resolveAppContext(applicationId: string): Promise<{
    app: { id: string; slug: string; clusterId: string; k8sNamespace: string };
    cluster: ClusterEntity;
    kubeconfig: string;
    ops: IVolumeExport;
    provider: CloudProvider;
  }> {
    const app = await this.applicationsRepository.findById(applicationId);
    if (!app)
      throw new NotFoundException(`Application ${applicationId} not found`);
    const cluster = await this.clusterRepository.findOne({
      where: { id: app.clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(
        `Cluster ${app.clusterId} for application ${applicationId} not found`,
      );
    }
    if (!cluster.kubeconfigEncrypted) {
      throw new BadRequestException(
        `Cluster ${cluster.id} has no kubeconfig — cannot operate on snapshots`,
      );
    }
    const provider = cluster.provider as CloudProvider;
    const ops = this.volumeExportService;
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );
    return {
      app: {
        id: app.id,
        slug: app.slug,
        clusterId: cluster.id,
        k8sNamespace: app.k8sNamespace,
      },
      cluster,
      kubeconfig,
      ops,
      provider,
    };
  }

  private async resolvePvcName(
    applicationId: string,
    explicitName: string | undefined,
  ): Promise<string> {
    const pvcNames = await this.resolvePvcNames(applicationId);
    if (pvcNames.length === 0) {
      throw new BadRequestException(
        `Application ${applicationId} has no PersistentVolumeClaim — nothing to snapshot`,
      );
    }
    if (explicitName) {
      if (!pvcNames.includes(explicitName)) {
        throw new BadRequestException(
          `Volume "${explicitName}" not found on application. Available: ${pvcNames.join(', ')}`,
        );
      }
      return explicitName;
    }
    if (pvcNames.length > 1) {
      throw new BadRequestException(
        `Application has multiple volumes; specify --volume <name>. Available: ${pvcNames.join(', ')}`,
      );
    }
    return pvcNames[0];
  }

  private async resolvePvcNames(applicationId: string): Promise<string[]> {
    const resources =
      await this.appResourcesRepository.findByApplicationId(applicationId);
    return resources
      .filter(
        (resource) =>
          resource.kind === ApplicationResourceKind.PERSISTENT_VOLUME_CLAIM,
      )
      .map((resource) => resource.name);
  }

  private async getSnapshotCapability(
    app: { id: string; k8sNamespace: string },
    kubeconfig: string,
    pvcNames: string[],
  ): Promise<SnapshotCapability> {
    if (pvcNames.length === 0) {
      return {
        supported: false,
        reason:
          'Snapshots are not available because this application has no persistent volume.',
      };
    }

    let unsupported: SnapshotCapability | undefined;
    for (const pvcName of pvcNames) {
      const capability = await this.snapshotStorageCapability.forPvc(
        kubeconfig,
        app.k8sNamespace,
        pvcName,
      );
      if (capability.supported) return capability;
      unsupported ??= capability;
    }
    return unsupported!;
  }

  private async requireSnapshotCapability(
    app: { id: string; k8sNamespace: string },
    kubeconfig: string,
    pvcNames: string[],
  ): Promise<void> {
    const capability = await this.getSnapshotCapability(
      app,
      kubeconfig,
      pvcNames,
    );
    if (!capability.supported) {
      throw new BadRequestException(capability.reason);
    }
  }

  private buildSnapshotName(slug: string, description?: string): string {
    const ts = new Date().toISOString().replaceAll(/[-:T]/g, '').slice(0, 14);
    const tail = description
      ? `-${description
          .toLowerCase()
          .replaceAll(/[^a-z0-9-]/g, '-')
          .slice(0, 20)}`
      : `-${uuid().slice(0, 6)}`;
    const candidate = `${slug}-snap-${ts}${tail}`;
    return candidate.replaceAll(/-+/g, '-').replaceAll(/-$/g, '').slice(0, 63);
  }
}
