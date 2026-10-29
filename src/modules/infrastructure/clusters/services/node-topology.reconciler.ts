import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { ClusterNodeEntity, NodeType } from '../entities/cluster-node.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { CapabilitiesProviderFactory } from '../../../providers/core/factories/capabilities-provider.factory';
import { CloudProvider } from '../../../providers/enums/cloud-provider.enum';
import {
  missingTopologyLabels,
  topologyLabels,
} from '../../../providers/core/node-topology';

export type NodeTopologyOutcome =
  | { state: 'done'; labelled: string[]; conflicts: string[] }
  | { state: 'skipped'; reason: string };

/**
 * Gives nodes that joined before topology labels existed the zone and region
 * their provider declares. A node registers its labels only once, when it
 * first joins, so only the API can label the nodes that are already there.
 */
@Injectable()
export class NodeTopologyReconciler {
  private readonly logger = new Logger(NodeTopologyReconciler.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
    private readonly capabilities: CapabilitiesProviderFactory,
  ) {}

  async reconcile(clusterId: string): Promise<NodeTopologyOutcome> {
    const cluster = await this.clusters.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster?.kubeconfigEncrypted) {
      return { state: 'skipped', reason: 'no kubeconfig' };
    }
    const provider = cluster.provider as CloudProvider;
    if (!this.capabilities.isProviderSupported(provider)) {
      return { state: 'skipped', reason: `unknown provider ${provider}` };
    }
    const declares = this.capabilities.getCapabilitiesService(provider);

    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
    const current = await this.kubernetes.listNodeLabels(kubeconfig);
    const labelled: string[] = [];
    const conflicts: string[] = [];
    for (const node of cluster.nodes ?? []) {
      const labels = current.get(node.serverName);
      if (!labels) continue;
      const desired = topologyLabels(
        declares.nodeTopology(this.locationOf(cluster, node)),
      );
      const diff = missingTopologyLabels(labels, desired);
      if (diff.conflicts.length) {
        conflicts.push(`${node.serverName}: ${diff.conflicts.join(', ')}`);
      }
      if (!Object.keys(diff.add).length) continue;
      await this.kubernetes.addNodeLabels(
        kubeconfig,
        node.serverName,
        diff.add,
      );
      labelled.push(node.serverName);
    }
    if (labelled.length) {
      this.logger.log(
        `[node-topology] ${cluster.name}: labelled ${labelled.join(', ')}`,
      );
    }
    if (conflicts.length) {
      this.logger.warn(
        `[node-topology] ${cluster.name}: left as they are, set to another value: ${conflicts.join('; ')}`,
      );
    }
    return { state: 'done', labelled, conflicts };
  }

  /** A worker with no recorded region is skipped rather than assumed to sit with the master. */
  private locationOf(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
  ): string | null {
    if (node.region) return node.region;
    return node.nodeType === NodeType.MASTER ? cluster.region : null;
  }
}
