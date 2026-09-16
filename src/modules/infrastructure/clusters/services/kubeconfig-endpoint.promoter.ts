import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import * as https from 'node:https';
import { ClusterEntity, ClusterType } from '../entities/cluster.entity';
import { NodeType } from '../entities/cluster-node.entity';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { WireGuardPeerService } from '../../networking/services/wireguard-peer.service';

const SERVER_LINE = /(\bserver:\s*https:\/\/)([^\s:/]+|\[[^\]]+\])(:\d+)?/;
const CA_DATA = /certificate-authority-data:\s*(\S+)/;

/**
 * Moves a workload's stored kubeconfig onto the overlay, once, after proving
 * the overlay actually answers there.
 *
 * The stored kubeconfig is written at creation and was never revisited, while
 * the address it should name changes the moment the tunnel comes up. Seen live:
 * the public endpoint stopped answering and the control lost the workload's API
 * with the tunnel sitting there working.
 *
 * One-way on purpose. A promotion that could also demote would be driven by
 * peer health, and health flaps: the handshake goes stale three minutes after
 * the last one while the sweep samples every ten, so a single missed rekey at
 * the wrong moment would rewrite the cluster's address. Health decides when the
 * tunnel has earned the traffic, never when to take it back.
 */
@Injectable()
export class KubeconfigEndpointPromoter {
  private readonly logger = new Logger(KubeconfigEndpointPromoter.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly encryption: EncryptionService,
    private readonly wgPeers: WireGuardPeerService,
  ) {}

  async promoteAll(): Promise<number> {
    if (process.env.FLUI_WG_ENABLED !== 'true') return 0;
    const clusters = await this.clusters.find({
      where: { clusterType: ClusterType.WORKLOAD, deletedAt: IsNull() },
      relations: ['nodes'],
    });
    let moved = 0;
    for (const cluster of clusters) {
      try {
        if (await this.promote(cluster)) moved += 1;
      } catch (err: any) {
        this.logger.warn(
          `[kubeconfig] ${cluster.name}: ${err?.message ?? err}`,
        );
      }
    }
    return moved;
  }

  async promote(cluster: ClusterEntity): Promise<boolean> {
    if (!cluster.kubeconfigEncrypted) return false;

    const master =
      (cluster.nodes ?? []).find((n) => n.nodeType === NodeType.MASTER) ??
      (cluster.nodes ?? [])[0];
    if (!master) return false;

    const overlay = await this.wgPeers.nodeOverlayFor(master.id);
    if (!overlay?.enrolled || !overlay.nodeAddress) return false;

    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
    const current = SERVER_LINE.exec(kubeconfig);
    if (!current) {
      this.logger.warn(`[kubeconfig] ${cluster.name}: no server line to move`);
      return false;
    }
    if (current[2] === overlay.nodeAddress) return false;

    const ca = CA_DATA.exec(kubeconfig)?.[1];
    if (!ca) {
      this.logger.warn(
        `[kubeconfig] ${cluster.name}: no certificate authority to verify the tunnel against — not moving`,
      );
      return false;
    }

    const port = current[3] ?? ':6443';
    if (!(await this.answers(overlay.nodeAddress, port.slice(1), ca))) {
      this.logger.log(
        `[kubeconfig] ${cluster.name}: ${overlay.nodeAddress} not answering yet — leaving ${current[2]} in place`,
      );
      return false;
    }

    cluster.kubeconfigEncrypted = this.encryption.encrypt(
      kubeconfig.replace(SERVER_LINE, `$1${overlay.nodeAddress}$3`),
    );
    await this.clusters.save(cluster);
    this.logger.log(
      `[kubeconfig] ${cluster.name}: API server moved from ${current[2]} to ${overlay.nodeAddress} over the overlay`,
    );
    return true;
  }

  /**
   * Verified against the cluster's own CA, taken from the kubeconfig being
   * moved — which makes this more than a reachability check. The API server's
   * certificate has to name the overlay address for a kubeconfig pointing there
   * to work at all, so a probe that skipped verification could happily promote
   * a cluster into a permanent TLS failure.
   *
   * Any HTTP answer proves the path: 401 is what an unauthenticated probe
   * should get, and getting it means TCP, TLS and the certificate's names all
   * worked over the tunnel. Only silence is a failure.
   */
  private answers(
    host: string,
    port: string,
    caBase64: string,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      let ca: Buffer;
      try {
        ca = Buffer.from(caBase64, 'base64');
      } catch {
        resolve(false);
        return;
      }
      const req = https.request(
        {
          host,
          port,
          path: '/readyz',
          method: 'GET',
          timeout: 5000,
          ca,
        },
        (res) => {
          res.resume();
          resolve(true);
        },
      );
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
      req.end();
    });
  }
}
