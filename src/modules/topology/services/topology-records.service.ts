import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { ApplicationEntity } from '../../applications/entities/application.entity';
import { ApplicationKind } from '../../applications/enums/application-kind.enum';
import { CatalogInstallEntity } from '../../catalog/entities/catalog-install.entity';
import { ClusterFirewallEntity } from '../../infrastructure/firewalls/entities/cluster-firewall.entity';
import {
  WireGuardPeerEntity,
  WireGuardPeerRole,
  WireGuardPeerStatus,
} from '../../infrastructure/networking/entities/wireguard-peer.entity';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { TopologyAppDto, TopologyProjectDto } from '../dto/topology.dto';
import {
  AppRecord,
  InstallRecord,
  installIdOf,
} from '../utils/topology-enrich.util';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What Flui's own records add to what the clusters say: names, stacks, projects, firewalls, the network. */
@Injectable()
export class TopologyRecordsService {
  private readonly logger = new Logger(TopologyRecordsService.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly appRepo: Repository<ApplicationEntity>,
    @InjectRepository(CatalogInstallEntity)
    private readonly installRepo: Repository<CatalogInstallEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepo: Repository<ProjectEntity>,
    @InjectRepository(ClusterFirewallEntity)
    private readonly firewallRepo: Repository<ClusterFirewallEntity>,
    @InjectRepository(WireGuardPeerEntity)
    private readonly peerRepo: Repository<WireGuardPeerEntity>,
  ) {}

  async appRecords(apps: TopologyAppDto[]): Promise<Map<string, AppRecord>> {
    const ids = apps.map((a) => a.id).filter((id) => UUID.test(id));
    if (!ids.length) return new Map();
    const rows = await this.appRepo.find({
      where: { id: In(ids) },
      withDeleted: true,
      select: [
        'id',
        'name',
        'deletedAt',
        'projectId',
        'slug',
        'exposure',
        'metadata',
        'labels',
        'sourceConfig',
      ],
    });
    return new Map(rows.map((r) => [r.id, r as AppRecord]));
  }

  async installRecords(
    records: Map<string, AppRecord>,
  ): Promise<Map<string, InstallRecord>> {
    const ids = [...new Set([...records.values()].map(installIdOf))].filter(
      (id): id is string => !!id && UUID.test(id),
    );
    if (!ids.length) return new Map();
    const rows = await this.installRepo.find({
      where: { id: In(ids), deletedAt: IsNull() },
      select: ['id', 'displayName', 'resolvedFqdn'],
    });
    return new Map(rows.map((r) => [r.id, r]));
  }

  /**
   * Platform workloads often carry no `flui-app-id` label and come out as
   * `namespace/name`. The one Flui recorded under that namespace and slug gives
   * them their id and name, so they read like every other app.
   */
  async adoptPlatformRecords(apps: TopologyAppDto[]): Promise<void> {
    const loose = apps.filter((a) => a.id.includes('/'));
    if (!loose.length) return;
    const rows = await this.appRepo.find({
      where: {
        clusterId: In([...new Set(loose.map((a) => a.clusterId))]),
        kind: ApplicationKind.SYSTEM,
      },
      select: ['id', 'clusterId', 'k8sNamespace', 'slug'],
    });
    const byPlace = new Map(
      rows.map((r) => [`${r.clusterId}|${r.k8sNamespace}|${r.slug}`, r.id]),
    );
    const taken = new Set(apps.map((a) => a.id));
    for (const app of loose) {
      const id = byPlace.get(`${app.clusterId}|${app.namespace}|${app.name}`);
      if (!id || taken.has(id)) continue;
      taken.add(id);
      app.id = id;
      app.stackId = `app:${id}`;
      app.groupKey = `app:${id}`;
    }
  }

  async projectRecords(
    records: Map<string, AppRecord>,
  ): Promise<TopologyProjectDto[]> {
    const ids = [
      ...new Set([...records.values()].map((r) => r.projectId)),
    ].filter((id): id is string => !!id && UUID.test(id));
    if (!ids.length) return [];
    const rows = await this.projectRepo.find({
      where: { id: In(ids) },
      select: ['id', 'name'],
      order: { name: 'ASC' },
    });
    return rows.map((r) => ({ id: r.id, name: r.name }));
  }

  async firewalls(
    clusterIds: string[],
  ): Promise<Map<string, ClusterFirewallEntity>> {
    if (!clusterIds.length) return new Map();
    const rows = await this.firewallRepo
      .find({
        where: { clusterId: In(clusterIds) },
        select: ['clusterId', 'lastAppliedRules', 'desiredRules'],
      })
      .catch((err: Error) => {
        this.logger.warn(`Cluster firewalls unavailable: ${err.message}`);
        return [] as ClusterFirewallEntity[];
      });
    return new Map(rows.map((r) => [r.clusterId, r]));
  }

  async overlayMembers(): Promise<Set<string>> {
    const peers = await this.peerRepo.find({
      where: {
        role: WireGuardPeerRole.MEMBER,
        status: WireGuardPeerStatus.ACTIVE,
      },
      select: ['clusterId'],
    });
    return new Set(peers.map((p) => p.clusterId));
  }
}
