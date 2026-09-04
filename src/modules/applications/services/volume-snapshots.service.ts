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
import {
  VolumeCopyPreflightService,
  describeCopyRisk,
} from './volume-copy-preflight.service';
import { VolumePauseLeaseService } from './volume-pause-lease.service';
import { ApplicationsRepository } from '../repositories/applications.repository';
import { AppResourcesRepository } from '../repositories/app-resources.repository';
import { ApplicationVolumeClaimsService } from './application-volume-claims.service';
import { VolumeCopyLedgerService } from './volume-copy-ledger.service';
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
  /** Copy a volume that holds a live database anyway. */
  allowInconsistent?: boolean;
  /** Stop the writers, copy at rest, then start them again. */
  pause?: boolean;
}

export interface SnapshotResponse extends ExportSummary {
  provider: CloudProvider;
  providerCapabilities: VolumeExportCapabilities;
  /** Set only when there is something true to say about this copy. */
  warning?: string;
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
    private readonly volumeClaims: ApplicationVolumeClaimsService,
    private readonly copyLedger: VolumeCopyLedgerService,
    private readonly preflight: VolumeCopyPreflightService,
    private readonly pauseLease: VolumePauseLeaseService,
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
    const pvcName = await this.resolvePvcName(
      kubeconfig,
      app,
      request.volumeName,
    );
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
        const { facts, paused } = await this.preflight.check({
          kubeconfig,
          namespace: app.k8sNamespace,
          pvcName,
          allowInconsistent: request.allowInconsistent,
          pause: request.pause,
        });
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
        let exp: ExportResult;
        try {
          exp = await ops.createExport({
            sink: 'pvc-clone',
            kubeconfig,
            namespace: app.k8sNamespace,
            sourcePvcName: pvcName,
            exportName: snapshotName,
            labels: baseLabels,
          });
        } finally {
          // Before the ledger write on purpose: bookkeeping must never extend
          // the outage, and a failed copy must still give the app back.
          await this.pauseLease.release(kubeconfig, paused);
        }
        this.logger.log(
          `[snapshot] Created ${exp.sink} ${exp.exportId} for app=${app.slug} cluster=${cluster.id} (provider=${provider})`,
        );
        await this.copyLedger.record({
          clusterId: cluster.id,
          applicationId: app.id,
          applicationSlug: app.slug,
          volumeName: pvcName,
          userId: request.userId,
          exportId: exp.exportId,
          sink: 'pvc-clone',
          sizeBytes: exp.actualBytes,
          clonePvcName: snapshotName,
          ...facts,
        });
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
          warning: describeCopyRisk(facts, exp.writesObservedDuringCopy),
        };
      },
    );
    return { ...result, operationId };
  }

  async listForApp(applicationId: string): Promise<SnapshotListResponse> {
    const { app, kubeconfig, ops, provider } =
      await this.resolveAppContext(applicationId);
    const pvcNames = await this.resolvePvcNames(kubeconfig, app);
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

    // `pvcNames` came back from the same cluster a moment ago, so an empty
    // `items` here is a real absence of copies rather than a failed call.
    await this.copyLedger.reconcile(
      app.clusterId,
      app.id,
      app.slug,
      items,
      pvcNames.length > 0,
    );

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
      : await this.resolvePvcNames(kubeconfig, app);
    await this.requireSnapshotCapability(app, kubeconfig, sourcePvcNames);

    // The tracked app_resources row never carries storageClassName (nothing
    // writes it there) — read it from the live claim instead, the same place
    // resolveForApplication already pulls it from.
    const tracked = await this.appResourcesRepository
      .findByApplicationId(app.id)
      .catch(() => []);
    const claims = await this.volumeClaims.resolveForApplication(
      kubeconfig,
      app,
      tracked,
      { excludeCopies: true },
    );
    const dataPvc = claims.find((c) => c.name === source.sourcePvcName);
    const storageClass = dataPvc?.storageClass ?? 'local-path';
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
    const pvcNames = await this.resolvePvcNames(kubeconfig, app);
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
        await this.copyLedger.forget(app.id, snapshotId);
        this.logger.log(`[snapshot] Deleted ${snapshotId} for app=${app.slug}`);
      },
    );
    return { operationId };
  }

  private async resolveAppContext(applicationId: string): Promise<{
    app: {
      id: string;
      slug: string;
      clusterId: string;
      k8sNamespace: string;
      kind?: string;
    };
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
        kind: app.kind,
      },
      cluster,
      kubeconfig,
      ops,
      provider,
    };
  }

  private async resolvePvcName(
    kubeconfig: string,
    app: { id: string; slug: string; k8sNamespace: string },
    explicitName: string | undefined,
  ): Promise<string> {
    const pvcNames = await this.resolvePvcNames(kubeconfig, app);
    if (pvcNames.length === 0) {
      throw new BadRequestException(
        `Application ${app.id} has no PersistentVolumeClaim — nothing to snapshot`,
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

  // A StatefulSet's volumeClaimTemplates never get a standalone PVC manifest
  // (and so no app_resources row) — resolveForApplication also matches on the
  // <template>-<statefulset>-<ordinal> naming Kubernetes itself mints, which is
  // the only way a database-shaped app's claim is ever found.
  private async resolvePvcNames(
    kubeconfig: string,
    app: { id: string; slug: string; k8sNamespace: string },
  ): Promise<string[]> {
    const tracked = await this.appResourcesRepository
      .findByApplicationId(app.id)
      .catch(() => []);
    const claims = await this.volumeClaims.resolveForApplication(
      kubeconfig,
      app,
      tracked,
      { excludeCopies: true },
    );
    return claims.map((c) => c.name);
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
