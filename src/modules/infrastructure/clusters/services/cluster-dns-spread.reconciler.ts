import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';

export const CLUSTER_DNS_REPLICAS = 2;
const RESPREAD_COOLDOWN_MS = 60 * 60 * 1000;

export type ClusterDnsSpreadOutcome =
  | 'spread'
  | 'respread'
  | 'already-spread'
  | 'single-node'
  | 'no-cluster-dns'
  | 'unreachable';

/**
 * Every copy in one location while another location has room: losing that
 * location takes name resolution with it, and with it every volume that has
 * to move. Not more than once an hour, in case the scheduler
 * keeps choosing the same location for its own reasons.
 */
export function dnsNeedsRespread(
  dns: { podZones: string[]; readyZones: string[]; respreadAt?: string },
  now: number,
): boolean {
  if (dns.podZones.length < 2 || new Set(dns.podZones).size > 1) return false;
  if (dns.readyZones.filter((z) => z !== dns.podZones[0]).length === 0)
    return false;
  const last = dns.respreadAt ? Date.parse(dns.respreadAt) : Number.NaN;
  return Number.isNaN(last) || now - last > RESPREAD_COOLDOWN_MS;
}

/**
 * Keeps the cluster DNS on two nodes once the cluster has two that are
 * ready, in two locations when it has them.
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
      if (
        dns.replicas >= CLUSTER_DNS_REPLICAS &&
        dns.spreadAcrossNodes &&
        dns.spreadAcrossZones
      ) {
        if (!dnsNeedsRespread(dns, Date.now())) return 'already-spread';
        await this.kubernetes.respreadClusterDns(
          kubeconfig,
          new Date().toISOString(),
        );
        this.logger.log(
          `[cluster-dns] ${cluster.name}: every copy was in ${dns.podZones[0]}; restarted so they spread over ${dns.readyZones.join(', ')}`,
        );
        return 'respread';
      }
      await this.kubernetes.spreadClusterDns(
        kubeconfig,
        Math.max(dns.replicas, CLUSTER_DNS_REPLICAS),
      );
      this.logger.log(
        `[cluster-dns] ${cluster.name}: ${dns.replicas} → ${Math.max(dns.replicas, CLUSTER_DNS_REPLICAS)} copies, spread across nodes and locations`,
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
