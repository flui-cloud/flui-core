import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  ClusterEntity,
  CONTROL_CLUSTER_TYPES,
} from '../entities/cluster.entity';
import { ApplicationEntity } from '../../../applications/entities/application.entity';
import { ClusterDnsZoneEntity } from '../../../dns/entities/cluster-dns-zone.entity';
import {
  ControlPair,
  PreviousControl,
} from '../interfaces/cluster-rebuild.interface';
import {
  NO_LIVE_CONTROL_REFUSAL,
  chooseControlSource,
  liveControl,
  missingZoneWarnings,
  toCandidate,
} from '../utils/control-restore.util';
import { isRebuildable } from '../utils/rebuild-scope.util';

/**
 * Which earlier control cluster a control restore takes its applications
 * from, and which live one it puts them on.
 */
@Injectable()
export class ControlRestoreSourceService {
  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(ClusterDnsZoneEntity)
    private readonly zoneAssignmentRepo: Repository<ClusterDnsZoneEntity>,
  ) {}

  async resolve(fromId?: string): Promise<ControlPair> {
    const controls = await this.clusterRepo.find({
      where: { clusterType: In([...CONTROL_CLUSTER_TYPES]) },
      order: { createdAt: 'DESC' },
    });
    const to = liveControl(controls);
    if (!to) return { refusal: NO_LIVE_CONTROL_REFUSAL, candidates: [] };

    const earlier = controls.filter((c) => c.id !== to.id);
    const candidates: PreviousControl[] = [];
    for (const cluster of earlier) {
      const restorable = await this.countRestorable(cluster.id, to.id);
      if (restorable === 0 && cluster.id !== fromId) continue;
      candidates.push(toCandidate(cluster, restorable));
    }
    return chooseControlSource(to, earlier, candidates, fromId);
  }

  async dnsWarnings(from: ClusterEntity, to: ClusterEntity): Promise<string[]> {
    try {
      const old = await this.zoneAssignmentRepo.find({
        where: { clusterId: from.id },
        relations: ['dnsZone'],
      });
      const served = new Set(
        (
          await this.zoneAssignmentRepo.find({ where: { clusterId: to.id } })
        ).map((a) => a.dnsZoneId),
      );
      const missing = old
        .filter((a) => !served.has(a.dnsZoneId))
        .map((a) => a.dnsZone?.zoneName ?? a.dnsZoneId);
      return missingZoneWarnings(to.name, missing);
    } catch {
      return [];
    }
  }

  private async countRestorable(
    clusterId: string,
    toId: string,
  ): Promise<number> {
    const applications = await this.appRepo
      .createQueryBuilder('a')
      .where('a."clusterId" = :id', { id: clusterId })
      .orWhere(
        `a."metadata"::jsonb -> 'rebuild' ->> 'from' = :id AND a."metadata"::jsonb -> 'rebuild' ->> 'to' = :to`,
        { id: clusterId, to: toId },
      )
      .getMany();
    return applications.filter(isRebuildable).length;
  }
}
