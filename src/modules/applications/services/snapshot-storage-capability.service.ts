import { Injectable } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';

export interface SnapshotCapability {
  supported: boolean;
  reason?: string;
}

/**
 * Whether a PVC's storage class still exists — the only thing the copy-pod
 * export primitive (VolumeExportService) actually needs, since it mounts the
 * source PVC directly rather than going through the CSI VolumeSnapshot API.
 *
 * This used to also refuse any non-CSI provisioner, which was meant to hide
 * snapshots on BYOS but instead disabled the feature everywhere: Flui's own
 * dedicated (`flui.cloud/local-path`) and shared (`rancher.io/local-path`)
 * classes are non-CSI on every provider, so that check refused the ONLY
 * snapshot mechanism that exists, unconditionally, on every real cluster.
 * A CSI fast path (VolumeSnapshotClass) is a real future option — see
 * IVolumeExport's own doc comment — but nothing in this codebase picks one
 * even when capability reports it, so there is nothing to gate on yet.
 */
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

    try {
      await storageApi.readStorageClass({ name: storageClassName });
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

    return { supported: true };
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
