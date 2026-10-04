import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';

export const CLUSTER_DNS_REPLICAS = 2;

export type ClusterDnsSpreadOutcome =
  | 'spread'
  | 'already-spread'
  | 'single-node'
  | 'no-cluster-dns'
  | 'unreachable';

/**
 * Keeps the cluster DNS on two nodes once the cluster has two that are
 * ready.
 *
 * K3s owns the `coredns` manifest and writes it back when it restarts, which
 * returns it to one copy. Changing that from K3s' side means restarting K3s on
 * every existing master; reconciling the live object reaches every cluster as
 * it is, and puts the second copy back within one tick of K3s removing it —
 * the first copy keeps answering in between.
 */
@Injectable()
export class ClusterDnsSpreadReconciler {
  private readonly logger = new Logger(ClusterDnsSpreadReconciler.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
  ) {}

  async reconcile(clusterId: string): Promise<ClusterDnsSpreadOutcome> {
    const cluster = await this.clusters.findOne({ where: { id: clusterId } });
    if (!cluster?.kubeconfigEncrypted) return 'unreachable';
    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
    try {
      const nodes = await this.kubernetes.listIngressNodeStates(kubeconfig);
      if (nodes.filter((n) => n.ready).length < 2) return 'single-node';
      const dns = await this.kubernetes.readClusterDns(kubeconfig);
      if (!dns) return 'no-cluster-dns';
      if (dns.replicas >= CLUSTER_DNS_REPLICAS && dns.spreadAcrossNodes) {
        return 'already-spread';
      }
      await this.kubernetes.spreadClusterDns(
        kubeconfig,
        Math.max(dns.replicas, CLUSTER_DNS_REPLICAS),
      );
      this.logger.log(
        `[cluster-dns] ${cluster.name}: ${dns.replicas} → ${Math.max(dns.replicas, CLUSTER_DNS_REPLICAS)} copies, spread across nodes`,
      );
      return 'spread';
    } catch (err) {
      this.logger.warn(
        `[cluster-dns] ${cluster.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'unreachable';
    }
  }
}
