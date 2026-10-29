import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Not, Repository } from 'typeorm';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { mergeClusterMetadata } from '../../infrastructure/clusters/utils/cluster-metadata-merge.util';
import { ClusterHaService } from './cluster-ha.service';
import { EtcdLeaderPlacementService } from './etcd-leader-placement.service';
import { SiteRoundTripService } from './site-round-trip.service';
import { HaObserved } from '../utils/ha-observed';

/**
 * On each cluster that spans three locations: puts the etcd leader back in a
 * location for data when it is not, and records where it is and how far the
 * locations are from one another, for the cluster's high availability view.
 */
@Injectable()
export class ClusterHaSweepService {
  private readonly logger = new Logger(ClusterHaSweepService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly clusterHa: ClusterHaService,
    private readonly etcdLeader: EtcdLeaderPlacementService,
    private readonly roundTrips: SiteRoundTripService,
  ) {}

  async sweep(): Promise<void> {
    const clusters = await this.clusters.find({
      where: { deletedAt: IsNull(), kubeconfigEncrypted: Not(IsNull()) },
    });
    for (const cluster of clusters) {
      await this.check(cluster).catch((err: any) =>
        this.logger.warn(`[ha] ${cluster.name}: ${err?.message ?? err}`),
      );
    }
  }

  async check(cluster: ClusterEntity): Promise<void> {
    const ha = await this.clusterHa.inspect(cluster.id);
    if (ha.state.level !== 'three-locations' || !ha.topology) return;
    const three = { ...ha, topology: ha.topology };
    const previous = (cluster.metadata as { haObserved?: HaObserved } | null)
      ?.haObserved;
    const leader = await this.etcdLeader
      .check(three, previous?.etcdLeaderMovedAt)
      .catch((err: any) => {
        this.logger.warn(
          `[ha] ${cluster.name}: etcd leader not read (${err?.message ?? err})`,
        );
        return null;
      });
    const trips = await this.roundTrips.measure(three).catch((err: any) => {
      this.logger.warn(
        `[ha] ${cluster.name}: round trips not measured (${err?.message ?? err})`,
      );
      return null;
    });
    const at = new Date().toISOString();
    const observed: HaObserved = {
      at,
      etcdLeader: leader ? { node: leader.node, zone: leader.zone } : null,
      roundTrips: trips ?? [],
      etcdLeaderMovedAt: leader?.moved ? at : previous?.etcdLeaderMovedAt,
    };
    await mergeClusterMetadata(this.clusters, cluster.id, {
      haObserved: observed,
    });
  }
}
