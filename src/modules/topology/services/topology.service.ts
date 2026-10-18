import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
} from '../../infrastructure/clusters/entities/cluster.entity';
import {
  ClusterNodeEntity,
  NodeType,
} from '../../infrastructure/clusters/entities/cluster-node.entity';
import { WireGuardPeerEntity } from '../../infrastructure/networking/entities/wireguard-peer.entity';
import { managementNetworkSwitch } from '../../infrastructure/networking/management-network.state';
import { exampleTopology } from '../../sandbox/stand-in/sandbox-world-topology';
import { TopologyResponseDto } from '../dto/topology.dto';
import { inboundOf } from '../utils/topology-inbound.util';
import { assignStacks } from '../utils/topology-enrich.util';
import { ClusterContext, ServerRecord } from './topology-k8s.helper';
import { TopologyLinksService } from './topology-links.service';
import { TopologyRecordsService } from './topology-records.service';
import { TopologyClusterReader } from './topology-cluster-reader.service';
import {
  ClusterPart,
  answerWithin,
  assembleResponse,
  clusterDto,
  fluiNetworkOf,
} from './topology-assembly.util';

const FLUI_MOCK_ENV = 'FLUI_TOPOLOGY_MOCK';
/** A cluster gets this long to answer; past it the map is drawn without waiting for it. */
const CLUSTER_DEADLINE_MS = 20_000;
/** A cluster that did not answer is asked again after this, not on every poll. */
const RETRY_SILENT_MS = 60_000;
/** While a cluster is silent its last known apps stay on the map, for this long at most. */
const KEEP_LAST_KNOWN_MS = 10 * 60_000;

/** The fleet's topology: every cluster read, joined with Flui's records, one snapshot. */
@Injectable()
export class TopologyService {
  private readonly logger = new Logger(TopologyService.name);
  private readonly lastGood = new Map<
    string,
    { part: ClusterPart; at: number }
  >();
  private readonly silentUntil = new Map<string, number>();

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodeRepo: Repository<ClusterNodeEntity>,
    @InjectRepository(WireGuardPeerEntity)
    private readonly peerRepo: Repository<WireGuardPeerEntity>,
    private readonly configService: ConfigService,
    private readonly linksService: TopologyLinksService,
    private readonly records: TopologyRecordsService,
    private readonly reader: TopologyClusterReader,
  ) {}

  isMockMode(): boolean {
    return this.configService.get<string>(FLUI_MOCK_ENV) === 'true';
  }

  async buildTopology(): Promise<TopologyResponseDto> {
    if (this.isMockMode()) return exampleTopology(Date.now());

    const clusters = await this.clusterRepo.find({
      where: { deletedAt: IsNull() },
      order: { createdAt: 'ASC' },
    });
    const parts = await Promise.all(
      clusters.map((cluster) => this.buildClusterPart(cluster)),
    );
    const apps = parts.flatMap((p) => p.apps);
    await this.records.adoptPlatformRecords(apps);
    const [records, members, firewalls] = await Promise.all([
      this.records.appRecords(apps),
      this.records.overlayMembers(),
      this.records.firewalls(clusters.map((c) => c.id)),
    ]);
    const [installs, projects] = await Promise.all([
      this.records.installRecords(records),
      this.records.projectRecords(records),
    ]);
    const stacks = assignStacks(apps, records, installs);
    const networkOn = managementNetworkSwitch().enabled;
    const clusterDtos = parts.map((p) =>
      clusterDto(p, stacks, {
        networkOn,
        member: members.has(p.cluster.id),
        inbound: inboundOf(firewalls.get(p.cluster.id)),
      }),
    );
    const { links, clusterLinks } = await this.linksService
      .build(
        apps,
        stacks,
        clusterDtos,
        parts.flatMap((p) =>
          p.refs.map((r) => ({ ...r, clusterId: p.cluster.id })),
        ),
      )
      .catch((err: Error) => {
        this.logger.warn(`Topology links unavailable: ${err.message}`);
        return { links: [], clusterLinks: [] };
      });

    return assembleResponse({
      clusters: clusterDtos,
      links,
      clusterLinks,
      servers: parts.flatMap((p) => p.servers),
      stacks,
      apps,
      projects,
      droppedApps: parts.reduce((sum, p) => sum + p.dropped, 0),
    });
  }

  private async buildClusterPart(cluster: ClusterEntity): Promise<ClusterPart> {
    const empty = {
      cluster,
      reached: false,
      servers: [],
      apps: [],
      dropped: 0,
      refs: [],
    };
    // Will not answer, and asking costs the full connect timeout on every poll.
    if (
      cluster.status === ClusterStatus.LOST ||
      cluster.status === ClusterStatus.STOPPED ||
      !cluster.kubeconfigEncrypted
    ) {
      return empty;
    }

    const [rows, peers] = await Promise.all([
      this.nodeRepo.find({ where: { clusterId: cluster.id } }),
      this.peerRepo.find({
        where: { clusterId: cluster.id },
        select: ['nodeId', 'status'],
      }),
    ]);
    const peerOf = new Map(
      peers.filter((p) => p.nodeId).map((p) => [p.nodeId!, p.status]),
    );
    const ctx: ClusterContext = {
      id: cluster.id,
      provider: cluster.provider,
      records: new Map<string, ServerRecord>(
        rows.map((n) => [
          n.serverName,
          {
            id: n.id,
            providerResourceId: n.providerResourceId || null,
            serverType: n.serverType ?? null,
            isMaster: n.nodeType === NodeType.MASTER,
            privateNetwork: !!n.subnetId,
            fluiNetwork: fluiNetworkOf(peerOf.get(n.id)),
          },
        ]),
      ),
    };

    const silent = this.silentUntil.get(cluster.id);
    if (silent && Date.now() < silent) return this.lastKnown(cluster, empty);
    try {
      const part = await answerWithin(
        this.reader.read(cluster, ctx),
        CLUSTER_DEADLINE_MS,
      );
      if (this.silentUntil.delete(cluster.id)) {
        this.logger.log(`Cluster ${cluster.id} answers the topology again`);
      }
      this.lastGood.set(cluster.id, { part, at: Date.now() });
      return part;
    } catch (error) {
      // Said once per silence, not on every poll.
      if (!this.silentUntil.has(cluster.id)) {
        this.logger.error(
          `Failed to build topology for cluster ${cluster.id}: ${(error as Error).message}`,
        );
      }
      this.silentUntil.set(cluster.id, Date.now() + RETRY_SILENT_MS);
      return this.lastKnown(cluster, empty);
    }
  }

  /** The cluster's last answer, drawn as not answering, so a short silence does not empty the map. */
  private lastKnown(cluster: ClusterEntity, empty: ClusterPart): ClusterPart {
    const known = this.lastGood.get(cluster.id);
    if (!known || Date.now() - known.at > KEEP_LAST_KNOWN_MS) return empty;
    return { ...known.part, cluster, reached: false };
  }
}

export { assembleResponse } from './topology-assembly.util';
export type { TopologyParts } from './topology-assembly.util';
