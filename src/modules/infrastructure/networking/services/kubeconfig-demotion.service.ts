import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  ClusterEntity,
  isControlClusterType,
} from '../../clusters/entities/cluster.entity';
import { NodeType } from '../../clusters/entities/cluster-node.entity';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { CrossProviderFirewallService } from '../../firewalls/services/cross-provider-firewall.service';
import {
  OverlayDemotion,
  overlayDemotionOf,
  serverHostOf,
  withServerHost,
} from '../kubeconfig-demotion';

export interface DemotionResult {
  clusterId: string;
  clusterName: string;
  from: string | null;
  to: string | null;
  changed: boolean;
  held: boolean;
}

/**
 * Puts a workload's API address back on the public path, by hand.
 *
 * The promoter is one-way on purpose — health flaps, and an address rewritten
 * on every stale handshake would be worse than none — so the way back is a
 * person's decision, never a health check's. The public 6443 rule follows the
 * stored kubeconfig, so it returns on the firewall pass this triggers.
 */
@Injectable()
export class KubeconfigDemotionService {
  private readonly logger = new Logger(KubeconfigDemotionService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly encryption: EncryptionService,
    @Optional() private readonly moduleRef?: ModuleRef,
  ) {}

  async demote(clusterId: string, by: string): Promise<DemotionResult> {
    const cluster = await this.workload(clusterId);
    const master =
      (cluster.nodes ?? []).find((n) => n.nodeType === NodeType.MASTER) ??
      (cluster.nodes ?? [])[0];
    const publicIp = master?.ipAddress?.trim();
    if (!publicIp) {
      throw new BadRequestException(
        `${cluster.name}'s first node has no public address to go back to`,
      );
    }
    if (!cluster.kubeconfigEncrypted) {
      throw new BadRequestException(`${cluster.name} has no stored kubeconfig`);
    }
    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
    const from = serverHostOf(kubeconfig);
    if (!from) {
      throw new BadRequestException(
        `${cluster.name}'s kubeconfig has no server line to move`,
      );
    }

    const changed = from !== publicIp;
    if (changed) {
      cluster.kubeconfigEncrypted = this.encryption.encrypt(
        withServerHost(kubeconfig, publicIp),
      );
    }
    const hold: OverlayDemotion = {
      at: new Date().toISOString(),
      by,
      from,
      to: publicIp,
    };
    cluster.metadata = { ...cluster.metadata, overlayDemotion: hold };
    await this.clusters.save(cluster);
    this.logger.warn(
      `[kubeconfig] ${cluster.name}: API server moved back from ${from} to ${publicIp} by ${by}; held off the Flui network until released`,
    );
    await this.reopenPublicPath();
    return {
      clusterId: cluster.id,
      clusterName: cluster.name,
      from,
      to: publicIp,
      changed,
      held: true,
    };
  }

  /** Lets the promoter take the cluster back onto the overlay once it answers there. */
  async release(clusterId: string, by: string): Promise<DemotionResult> {
    const cluster = await this.workload(clusterId);
    const hold = overlayDemotionOf(cluster);
    if (hold) {
      const rest = { ...cluster.metadata };
      delete rest.overlayDemotion;
      cluster.metadata = rest;
      await this.clusters.save(cluster);
      this.logger.log(
        `[kubeconfig] ${cluster.name}: hold off the Flui network released by ${by}`,
      );
    }
    return {
      clusterId: cluster.id,
      clusterName: cluster.name,
      from: null,
      to: null,
      changed: false,
      held: false,
    };
  }

  private async workload(clusterId: string): Promise<ClusterEntity> {
    const cluster = await this.clusters.findOne({
      where: { id: clusterId },
      relations: ['nodes'],
    });
    if (!cluster || cluster.deletedAt) {
      throw new NotFoundException(`Cluster ${clusterId} not found`);
    }
    if (isControlClusterType(cluster.clusterType)) {
      throw new BadRequestException(
        `${cluster.name} is the control cluster: its API server is never addressed over the Flui network`,
      );
    }
    return cluster;
  }

  private async reopenPublicPath(): Promise<void> {
    const firewall = this.moduleRef?.get(CrossProviderFirewallService, {
      strict: false,
    });
    if (!firewall) return;
    try {
      await firewall.reconcileAllPeers();
    } catch (error) {
      this.logger.warn(
        `[kubeconfig] the public API rule will return on the next firewall pass: ${(error as Error).message}`,
      );
    }
  }
}
