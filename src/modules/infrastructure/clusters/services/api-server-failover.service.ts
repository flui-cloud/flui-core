import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { ClusterEntity, ClusterType } from '../entities/cluster.entity';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { WireGuardPeerService } from '../../networking/services/wireguard-peer.service';
import { ApiServerSanService } from '../../networking/services/api-server-san.service';
import { managementNetworkOn } from '../../networking/management-network.state';
import { apiServerAnswers } from '../../networking/api-server-probe';
import {
  SERVER_LINE,
  overlayDemotionOf,
  withServerHost,
} from '../../networking/kubeconfig-demotion';
import {
  KnownApiServer,
  knownApiServers,
  readyServerCount,
  sameServers,
} from './api-server-failover.core';
import { mergeClusterMetadata } from '../utils/cluster-metadata-merge.util';

const CA_DATA = /certificate-authority-data:\s*(\S+)/;

/** Below this, restarting a server to change its certificate could stop the control plane. */
const SERVERS_FOR_A_RESTART = 3;

/**
 * Keeps a cluster with several servers reachable when the one Flui talks to
 * is lost. While that server answers, the sweep learns the others and makes
 * sure each one's certificate names the overlay address Flui would use, one
 * server per sweep. When it stops answering, the stored address moves to the
 * first other server that answers with a certificate the cluster's CA
 * vouches for. The promoter moves it back to the master once the master is
 * reachable again.
 */
@Injectable()
export class ApiServerFailoverService {
  private readonly logger = new Logger(ApiServerFailoverService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly encryption: EncryptionService,
    private readonly kubernetes: KubernetesService,
    private readonly wgPeers: WireGuardPeerService,
    private readonly apiServerSan: ApiServerSanService,
  ) {}

  async sweep(): Promise<void> {
    if (!managementNetworkOn()) return;
    const clusters = await this.clusters.find({
      where: { clusterType: ClusterType.WORKLOAD, deletedAt: IsNull() },
      relations: ['nodes'],
    });
    for (const cluster of clusters) {
      try {
        await this.check(cluster);
      } catch (err: any) {
        this.logger.warn(
          `[api-server] ${cluster.name}: ${err?.message ?? err}`,
        );
      }
    }
  }

  async check(cluster: ClusterEntity): Promise<void> {
    if (!cluster.kubeconfigEncrypted || overlayDemotionOf(cluster)) return;
    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
    const line = SERVER_LINE.exec(kubeconfig);
    const ca = CA_DATA.exec(kubeconfig)?.[1];
    if (!line || !ca) return;
    const current = line[2];
    const port = (line[3] ?? ':6443').slice(1);

    if (await apiServerAnswers(current, port, ca)) {
      await this.learn(cluster, kubeconfig, current, port, ca);
      return;
    }
    const known = knownOf(cluster);
    for (const server of known.filter((s) => s.address !== current)) {
      if (await apiServerAnswers(server.address, port, ca)) {
        await this.clusters.update(cluster.id, {
          kubeconfigEncrypted: this.encryption.encrypt(
            withServerHost(kubeconfig, server.address),
          ),
        });
        this.logger.warn(
          `[api-server] ${cluster.name}: ${current} does not answer; Flui now reaches the cluster through ${server.name}`,
        );
        return;
      }
    }
    if (known.length > 1) {
      this.logger.warn(
        `[api-server] ${cluster.name}: none of its ${known.length} servers answers`,
      );
    }
  }

  private async learn(
    cluster: ClusterEntity,
    kubeconfig: string,
    current: string,
    port: string,
    ca: string,
  ): Promise<void> {
    const nodes = await this.kubernetes.listNodes(kubeconfig);
    const overlay = new Map<string, string>();
    for (const node of cluster.nodes ?? []) {
      const reserved = await this.wgPeers.nodeOverlayFor(node.id);
      if (reserved?.enrolled) overlay.set(node.id, reserved.nodeAddress);
    }
    const servers = knownApiServers(nodes, cluster.nodes ?? [], overlay);
    const reachable: KnownApiServer[] = [];
    let restarted = false;
    for (const server of servers) {
      if (
        server.address === current ||
        (await apiServerAnswers(server.address, port, ca))
      ) {
        reachable.push(server);
        continue;
      }
      if (restarted || readyServerCount(nodes) < SERVERS_FOR_A_RESTART)
        continue;
      restarted = true;
      const result = await this.apiServerSan
        .enrolOverlayAddress(cluster.id, server.nodeId)
        .catch((err: any) => {
          this.logger.warn(
            `[api-server] ${cluster.name}: could not name ${server.address} in ${server.name}'s certificate (${err?.message ?? err})`,
          );
          return null;
        });
      if (result && (await apiServerAnswers(server.address, port, ca))) {
        reachable.push(server);
      }
    }
    if (sameServers(reachable, knownOf(cluster))) return;
    await mergeClusterMetadata(this.clusters, cluster.id, {
      apiServers: reachable,
    });
    this.logger.log(
      `[api-server] ${cluster.name}: reachable through ${reachable.map((s) => s.name).join(', ') || 'no server yet'}`,
    );
  }
}

function knownOf(cluster: ClusterEntity): KnownApiServer[] {
  return (
    (cluster.metadata as { apiServers?: KnownApiServer[] } | null)
      ?.apiServers ?? []
  );
}
