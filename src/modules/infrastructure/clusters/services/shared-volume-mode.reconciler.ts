import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { NodeType } from '../entities/cluster-node.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import {
  SHARED_STORAGE_PATH,
  SharedVolumeMode,
  desiredVolumeMode,
  localPathConfigFor,
  observedVolumeConfig,
} from './shared-volume-mode.core';

export interface SharedVolumesRecord {
  mode: SharedVolumeMode;
  nodesWithoutShare: string[];
  checkedAt: string;
}

export type SharedVolumeOutcome =
  | { state: 'set'; mode: SharedVolumeMode; nodesWithoutShare: string[] }
  | { state: 'unchanged'; mode: SharedVolumeMode; nodesWithoutShare: string[] }
  | { state: 'skipped'; reason: string };

const PROBE_FILE = '/host/.flui/share-probe';

/**
 * Makes new volumes usable from any node once every node is proven to see
 * the shared storage, and keeps them on their node while one does not.
 *
 * Proven, not assumed: joining a worker mounts the shared storage, but a
 * failed mount does not stop the join. So a fresh token is written on the
 * master and read back on every other node; a node that does not read it back
 * is named, and volumes stay pinned until it does.
 *
 * Volumes that already exist keep the node they were created on — Kubernetes
 * does not let that change. Only new volumes follow the setting; the
 * application availability check names any volume still tied to a node.
 */
@Injectable()
export class SharedVolumeModeReconciler {
  private readonly logger = new Logger(SharedVolumeModeReconciler.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
  ) {}

  async reconcile(clusterId: string): Promise<SharedVolumeOutcome> {
    const cluster = await this.clusters.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster?.kubeconfigEncrypted) {
      return { state: 'skipped', reason: 'no kubeconfig' };
    }
    if (!cluster.sharedStorageEnabled) {
      return { state: 'skipped', reason: 'shared storage is off' };
    }
    const master = (cluster.nodes ?? []).find(
      (n) => n.nodeType === NodeType.MASTER,
    )?.serverName;
    if (!master) return { state: 'skipped', reason: 'no master node recorded' };

    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
    const current = await this.kubernetes.readConfigMapKey(
      kubeconfig,
      'kube-system',
      'local-path-config',
      'config.json',
    );
    if (current === null) {
      return { state: 'skipped', reason: 'no volume provisioner settings' };
    }
    const observed = observedVolumeConfig(current);
    if (observed === 'custom') {
      return {
        state: 'skipped',
        reason: 'the volume provisioner settings were changed by hand',
      };
    }

    const ready = (await this.kubernetes.listIngressNodeStates(kubeconfig))
      .filter((n) => n.ready)
      .map((n) => n.name);
    if (!ready.includes(master)) {
      return { state: 'skipped', reason: 'the master is not ready' };
    }

    const token = randomUUID();
    await this.kubernetes.runOnNode(
      kubeconfig,
      master,
      SHARED_STORAGE_PATH,
      `mkdir -p /host/.flui && echo ${token} > ${PROBE_FILE}`,
    );
    const nodesWithoutShare: string[] = [];
    for (const node of ready.filter((n) => n !== master)) {
      const seen = await this.kubernetes
        .runOnNode(
          kubeconfig,
          node,
          SHARED_STORAGE_PATH,
          `cat ${PROBE_FILE} 2>/dev/null || true`,
        )
        .catch(() => '');
      if (seen.trim() !== token) nodesWithoutShare.push(node);
    }

    const mode = desiredVolumeMode(nodesWithoutShare);
    let state: 'set' | 'unchanged' = 'unchanged';
    if (observed !== mode) {
      await this.kubernetes.writeConfigMapKey(
        kubeconfig,
        'kube-system',
        'local-path-config',
        'config.json',
        localPathConfigFor(mode),
      );
      await this.kubernetes.restartWorkload(
        kubeconfig,
        'Deployment',
        'kube-system',
        'local-path-provisioner',
      );
      state = 'set';
      this.logger.log(
        `[shared-volumes] ${cluster.name}: ${observed} → ${mode}` +
          (nodesWithoutShare.length
            ? ` (${nodesWithoutShare.join(', ')} do not see the shared storage)`
            : ''),
      );
    }
    await this.record(cluster, { mode, nodesWithoutShare });
    return { state, mode, nodesWithoutShare };
  }

  /** Merged onto the freshest metadata so a concurrent write is not undone. */
  private async record(
    cluster: ClusterEntity,
    result: Omit<SharedVolumesRecord, 'checkedAt'>,
  ): Promise<void> {
    const fresh = await this.clusters.findOne({ where: { id: cluster.id } });
    const sharedVolumes: SharedVolumesRecord = {
      ...result,
      checkedAt: new Date().toISOString(),
    };
    const metadata: ClusterEntity['metadata'] = {
      ...(fresh ?? cluster).metadata,
      sharedVolumes: { ...sharedVolumes },
    };
    await this.clusters.update(cluster.id, { metadata });
  }
}
