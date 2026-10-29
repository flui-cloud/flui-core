import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as k8s from '@kubernetes/client-node';
import { ClusterEntity, ClusterStatus } from '../entities/cluster.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import {
  ClusterStorageNfsDto,
  ClusterStoragePvcSummaryDto,
  ClusterStorageStatus,
  ClusterStorageStatusDto,
  ClusterStorageVolumeDto,
} from '../dto/cluster-storage.dto';
import {
  FLUI_SHARED_STORAGE_PATH,
  FLUI_SHARED_VOLUME_FS_LABEL,
  FluiStorageClass,
  NFS_EXPORT_OPTIONS,
  nfsDurability,
  NFS_MOUNT_OPTIONS,
} from '../constants/storage-conventions';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';

@Injectable()
export class ClusterStorageService {
  private readonly logger = new Logger(ClusterStorageService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepository: Repository<ClusterEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
  ) {}

  async getStatus(clusterId: string): Promise<ClusterStorageStatusDto> {
    const cluster = await this.clusterRepository.findOne({
      where: { id: clusterId },
    });
    if (!cluster) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }

    const enabled = cluster.sharedStorageEnabled !== false;
    const result: ClusterStorageStatusDto = {
      clusterId: cluster.id,
      enabled,
      status: ClusterStorageStatus.DISABLED,
    };

    if (!enabled) {
      result.message = 'Shared storage disabled at cluster creation';
      return result;
    }

    const volume: ClusterStorageVolumeDto | undefined =
      cluster.sharedStorageVolumeId
        ? {
            provider: cluster.provider as CloudProvider,
            volumeId: cluster.sharedStorageVolumeId,
            sizeGb: cluster.sharedStorageVolumeSizeGb ?? 0,
            mountPath: FLUI_SHARED_STORAGE_PATH,
            fsLabel: FLUI_SHARED_VOLUME_FS_LABEL,
          }
        : undefined;

    const nfs: ClusterStorageNfsDto = {
      exportPath: FLUI_SHARED_STORAGE_PATH,
      exportOptions: NFS_EXPORT_OPTIONS,
      mountOptions: NFS_MOUNT_OPTIONS,
      ...nfsDurability(NFS_EXPORT_OPTIONS),
    };

    result.volume = volume;
    result.nfs = nfs;

    if (cluster.status !== ClusterStatus.READY) {
      result.status = ClusterStorageStatus.PROVISIONING;
      result.message = `Cluster is in status ${cluster.status} — storage layer not yet observable`;
      return result;
    }

    try {
      result.pvcs = await this.collectPvcSummary(cluster);
      result.status = ClusterStorageStatus.READY;
    } catch (err) {
      this.logger.warn(
        `[ClusterStorage] PVC summary failed for cluster ${cluster.id}: ${(err as Error).message}`,
      );
      result.status = ClusterStorageStatus.DEGRADED;
      result.message = `Could not query PVCs: ${(err as Error).message}`;
    }

    return result;
  }

  private async collectPvcSummary(
    cluster: ClusterEntity,
  ): Promise<ClusterStoragePvcSummaryDto> {
    if (!cluster.kubeconfigEncrypted) {
      throw new Error('kubeconfig not available for this cluster');
    }
    const kubeconfig = this.encryptionService.decrypt(
      cluster.kubeconfigEncrypted,
    );

    const kc = this.kubernetesService.makeKubeConfig(kubeconfig);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const response = await coreApi.listPersistentVolumeClaimForAllNamespaces();
    const items: any[] =
      (response as any).items ?? (response as any).body?.items ?? [];

    let bound = 0;
    let requestedBytes = 0;
    const byNamespace: Record<string, number> = {};

    for (const item of items) {
      const phase = item?.status?.phase as string | undefined;
      if (phase !== 'Bound') continue;
      const sc = item?.spec?.storageClassName as string | undefined;
      if (sc && sc !== FluiStorageClass.SHARED && sc !== '') continue;

      bound++;
      const ns = (item?.metadata?.namespace as string) || 'default';
      byNamespace[ns] = (byNamespace[ns] || 0) + 1;

      const requested = item?.spec?.resources?.requests?.storage as
        | string
        | undefined;
      if (requested) {
        requestedBytes += this.parseQuantityToBytes(requested);
      }
    }

    return {
      bound,
      requestedGb: Math.round((requestedBytes / 1_000_000_000) * 100) / 100,
      byNamespace,
    };
  }

  private parseQuantityToBytes(quantity: string): number {
    const m = /^(\d+(?:\.\d+)?)([KMGTPE]i?)?$/.exec(quantity);
    if (!m) return 0;
    const value = Number.parseFloat(m[1]);
    const unit = m[2] || '';
    const map: Record<string, number> = {
      '': 1,
      K: 1e3,
      M: 1e6,
      G: 1e9,
      T: 1e12,
      P: 1e15,
      E: 1e18,
      Ki: 1024,
      Mi: 1024 ** 2,
      Gi: 1024 ** 3,
      Ti: 1024 ** 4,
      Pi: 1024 ** 5,
      Ei: 1024 ** 6,
    };
    return value * (map[unit] ?? 1);
  }
}
