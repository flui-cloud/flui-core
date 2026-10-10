import { LOCAL_JOB } from '../../../common/leadership/scheduler-leadership.service';
import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleInit,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Not, Repository } from 'typeorm';
import {
  ClusterEntity,
  ClusterStatus,
  ClusterType,
  isControlClusterType,
} from '../../clusters/entities/cluster.entity';
import { ClusterNodeEntity } from '../../clusters/entities/cluster-node.entity';
import { ManagementAddressResolver } from '../../shared/services/management-address.resolver';
import {
  WireGuardPeerRole,
  WireGuardPeerStatus,
} from '../entities/wireguard-peer.entity';
import {
  ManagementNetworkDto,
  ManagementNetworkMemberDto,
} from '../dto/management-network.dto';
import {
  managementNetworkSwitch,
  rememberSwitch,
  resolveSwitch,
} from '../management-network.state';
import { WireGuardPeerService } from './wireguard-peer.service';
import { controlEndProblem } from '../control-end-health';

const WG_DEFAULT_PORT = 51821;

interface StoredSwitch {
  enabled?: boolean;
  changedAt?: string;
  changedBy?: string;
}

/**
 * The Flui network as an installation setting: stored on the control cluster
 * (so an installer refresh cannot switch it off), read back into the process
 * every minute and on every change, and described with what stands in its way.
 */
@Injectable()
export class ManagementNetworkService implements OnModuleInit {
  private readonly logger = new Logger(ManagementNetworkService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodes: Repository<ClusterNodeEntity>,
    private readonly peers: WireGuardPeerService,
    private readonly addresses: ManagementAddressResolver,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.refresh().catch((err: Error) =>
      this.logger.warn(
        `[flui-network] could not read the stored switch: ${err.message}`,
      ),
    );
  }

  @Cron(CronExpression.EVERY_MINUTE, { name: `${LOCAL_JOB}management-network` })
  async refresh(): Promise<void> {
    const control = await this.control();
    rememberSwitch(resolveSwitch(this.storedOf(control)));
  }

  async status(): Promise<ManagementNetworkDto> {
    await this.refresh();
    const control = await this.control();
    const current = managementNetworkSwitch();
    const hub = await this.peers.controlPeer();
    return {
      enabled: current.enabled,
      source: current.source,
      unavailable: this.unavailableOn(control),
      hub: hub
        ? {
            address: hub.managementIp,
            endpoint: hub.endpointHost
              ? `${hub.endpointHost}:${hub.listenPort ?? WG_DEFAULT_PORT}`
              : null,
            keyed: Boolean(hub.publicKey),
          }
        : null,
      hubProblem: current.enabled
        ? (controlEndProblem()?.message ?? null)
        : null,
      members: await this.members(),
    };
  }

  async set(enabled: boolean, by = 'a person'): Promise<ManagementNetworkDto> {
    const control = await this.control();
    if (!control) {
      throw new BadRequestException(
        'This installation has no control cluster, so there is nothing for the Flui network to connect to',
      );
    }
    if (enabled) {
      const reason = this.unavailableOn(control);
      if (reason) throw new BadRequestException(reason);
    }
    const stored: StoredSwitch = {
      enabled,
      changedAt: new Date().toISOString(),
      changedBy: by,
    };
    control.metadata = {
      ...control.metadata,
      managementNetwork: stored,
    } as ClusterEntity['metadata'];
    await this.clusters.save(control);
    rememberSwitch(resolveSwitch(stored));
    this.logger.log(
      `[flui-network] switched ${enabled ? 'on' : 'off'} by ${by}`,
    );
    return this.status();
  }

  /** What makes the Flui network impossible here, in words a person can act on. */
  private unavailableOn(control: ClusterEntity | null): string | null {
    if (!control) return 'This installation has no control cluster yet.';
    if (!this.addresses.publicAddressOf(control)) {
      return 'The control cluster has no address the other clusters can reach (for example a machine behind NAT), so they could not dial in.';
    }
    return null;
  }

  private async members(): Promise<ManagementNetworkMemberDto[]> {
    const live = (await this.peers.livePeers()).filter(
      (p) => p.role === WireGuardPeerRole.MEMBER,
    );
    if (!live.length) return [];
    const clusterIds = [...new Set(live.map((p) => p.clusterId))];
    const nodeIds = live
      .map((p) => p.nodeId)
      .filter((id): id is string => !!id);
    const [clusters, nodes] = await Promise.all([
      this.clusters.find({ where: { id: In(clusterIds) } }),
      nodeIds.length
        ? this.nodes.find({ where: { id: In(nodeIds) } })
        : Promise.resolve([] as ClusterNodeEntity[]),
    ]);
    const onControl = new Set(
      clusters
        .filter((c) => isControlClusterType(c.clusterType))
        .map((c) => c.id),
    );
    const clusterName = new Map(clusters.map((c) => [c.id, c.name]));
    const nodeName = new Map<string, string>(
      nodes.map((n) => [n.id, n.serverName]),
    );
    return live
      .filter((p) => !onControl.has(p.clusterId))
      .map((p) => ({
        clusterId: p.clusterId,
        clusterName: clusterName.get(p.clusterId) ?? 'removed cluster',
        nodeName: p.nodeId ? (nodeName.get(p.nodeId) ?? null) : null,
        address: p.managementIp,
        status: statusOf(p.status),
        lastHandshakeAt: p.lastHandshakeAt
          ? new Date(p.lastHandshakeAt).toISOString()
          : null,
      }))
      .sort((a, b) =>
        `${a.clusterName}/${a.nodeName}`.localeCompare(
          `${b.clusterName}/${b.nodeName}`,
        ),
      );
  }

  private async control(): Promise<ClusterEntity | null> {
    const candidates = (
      await this.clusters.find({
        where: { status: Not(ClusterStatus.DELETED) },
        relations: ['nodes'],
      })
    ).filter((c) => isControlClusterType(c.clusterType));
    const rank = (c: ClusterEntity) =>
      c.clusterType === ClusterType.CONTROL ? 0 : 1;
    return (
      [...candidates].sort(
        (a, b) =>
          rank(a) - rank(b) ||
          (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
      )[0] ?? null
    );
  }

  private storedOf(control: ClusterEntity | null): StoredSwitch | undefined {
    return (
      control?.metadata as { managementNetwork?: StoredSwitch } | undefined
    )?.managementNetwork;
  }
}

function statusOf(status: WireGuardPeerStatus): 'pending' | 'active' | 'stale' {
  if (status === WireGuardPeerStatus.ACTIVE) return 'active';
  if (status === WireGuardPeerStatus.STALE) return 'stale';
  return 'pending';
}
