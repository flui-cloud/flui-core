import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { TOPOLOGY_ZONE_LABEL } from '../../../providers/core/node-topology';
import {
  LINSTOR_CONTROLLER_DEPLOYMENT,
  LINSTOR_CONTROLLER_SELECTOR,
  PIRAEUS_NAMESPACE,
  REPLICATED_POOL,
} from '../../../replicated-volumes/replicated-volumes.constants';
import {
  DiskSpace,
  NodeDisk,
  copiesFromStoragePools,
  diskFromSummary,
  diskWarnings,
} from '../utils/node-disks.core';

/**
 * How much room is left on each node: its own disk, where databases and
 * dedicated data live, and the space set aside for copies of replicated
 * volumes. Both have a ceiling, the node's disk, and nothing warns when it
 * comes close unless this is read.
 */
@Injectable()
export class NodeDisksService {
  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly encryption: EncryptionService,
    private readonly kubernetes: KubernetesService,
  ) {}

  async view(
    clusterId: string,
  ): Promise<{ measuredAt: string; nodes: NodeDisk[]; warnings: string[] }> {
    const cluster = await this.clusters.findOne({ where: { id: clusterId } });
    if (!cluster?.kubeconfigEncrypted) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }
    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
    const [k8sNodes, copies] = await Promise.all([
      this.kubernetes.listNodes(kubeconfig),
      this.copies(kubeconfig),
    ]);
    const nodes: NodeDisk[] = await Promise.all(
      k8sNodes.map(async (n) => {
        const name = n.metadata?.name ?? '';
        return {
          node: name,
          zone: n.metadata?.labels?.[TOPOLOGY_ZONE_LABEL] ?? null,
          disk: diskFromSummary(
            await this.kubernetes.nodeStatsSummary(kubeconfig, name),
          ),
          copies: copies.get(name) ?? null,
        };
      }),
    );
    nodes.sort((a, b) => a.node.localeCompare(b.node));
    return {
      measuredAt: new Date().toISOString(),
      nodes,
      warnings: diskWarnings(nodes),
    };
  }

  /** Empty on a cluster without replicated volumes. */
  private async copies(kubeconfig: string): Promise<Map<string, DiskSpace>> {
    try {
      return copiesFromStoragePools(
        await this.kubernetes.execInPod(
          kubeconfig,
          PIRAEUS_NAMESPACE,
          LINSTOR_CONTROLLER_SELECTOR,
          LINSTOR_CONTROLLER_DEPLOYMENT,
          ['linstor', '-m', '--output-version', 'v1', 'storage-pool', 'list'],
        ),
        REPLICATED_POOL,
      );
    } catch {
      return new Map();
    }
  }
}
