import { Injectable } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';

const NON_CSI_PROVISIONERS = new Set([
  'rancher.io/local-path',
  'flui.cloud/local-path',
  'kubernetes.io/no-provisioner',
]);

export interface SnapshotCapability {
  supported: boolean;
  reason?: string;
}

export interface SnapshotStorageSignals {
  provisioner: string;
  volumeSnapshotClassDrivers: string[] | null;
}

export function decideSnapshotCapability(
  signals: SnapshotStorageSignals,
): SnapshotCapability {
  if (NON_CSI_PROVISIONERS.has(signals.provisioner)) {
    return {
      supported: false,
      reason:
        "Snapshots are not available because this cluster's storage class does not use a CSI driver.",
    };
  }

  if (signals.volumeSnapshotClassDrivers === null) {
    return {
      supported: false,
      reason:
        'Snapshots are not available because the cluster does not have the Kubernetes VolumeSnapshot API installed.',
    };
  }

  if (!signals.volumeSnapshotClassDrivers.includes(signals.provisioner)) {
    return {
      supported: false,
      reason:
        "Snapshots are not available because no VolumeSnapshotClass is configured for this volume's CSI storage driver.",
    };
  }

  return { supported: true };
}

@Injectable()
export class SnapshotStorageCapabilityService {
  constructor(private readonly kubernetesService: KubernetesService) {}

  async forPvc(
    kubeconfig: string,
    namespace: string,
    pvcName: string,
  ): Promise<SnapshotCapability> {
    const kc = this.kubernetesService.makeKubeConfig(kubeconfig);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const storageApi = kc.makeApiClient(k8s.StorageV1Api);
    const customObjectsApi = kc.makeApiClient(k8s.CustomObjectsApi);

    let pvc: k8s.V1PersistentVolumeClaim;
    try {
      pvc = await coreApi.readNamespacedPersistentVolumeClaim({
        name: pvcName,
        namespace,
      });
    } catch (error) {
      if (this.statusCode(error) === 404) {
        return {
          supported: false,
          reason:
            'Snapshots are not available because the application volume no longer exists on the cluster.',
        };
      }
      throw error;
    }

    const storageClassName = pvc.spec?.storageClassName;
    if (!storageClassName) {
      return {
        supported: false,
        reason:
          'Snapshots are not available because the application volume has no StorageClass.',
      };
    }

    let storageClass: k8s.V1StorageClass;
    try {
      storageClass = await storageApi.readStorageClass({
        name: storageClassName,
      });
    } catch (error) {
      if (this.statusCode(error) === 404) {
        return {
          supported: false,
          reason:
            "Snapshots are not available because the application volume's StorageClass no longer exists.",
        };
      }
      throw error;
    }

    const provisioner = storageClass.provisioner;
    if (NON_CSI_PROVISIONERS.has(provisioner)) {
      return decideSnapshotCapability({
        provisioner,
        volumeSnapshotClassDrivers: [],
      });
    }

    let volumeSnapshotClassDrivers: string[] | null;
    try {
      const response = await customObjectsApi.listClusterCustomObject({
        group: 'snapshot.storage.k8s.io',
        version: 'v1',
        plural: 'volumesnapshotclasses',
      });
      const items =
        (response as { items?: Array<{ driver?: string }> }).items ?? [];
      volumeSnapshotClassDrivers = items
        .map((item) => item.driver)
        .filter((driver): driver is string => Boolean(driver));
    } catch (error) {
      if (this.statusCode(error) !== 404) throw error;
      volumeSnapshotClassDrivers = null;
    }

    return decideSnapshotCapability({
      provisioner,
      volumeSnapshotClassDrivers,
    });
  }

  private statusCode(error: unknown): number | undefined {
    const candidate = error as {
      statusCode?: number;
      response?: { statusCode?: number; status?: number };
    };
    return (
      candidate?.statusCode ??
      candidate?.response?.statusCode ??
      candidate?.response?.status
    );
  }
}
