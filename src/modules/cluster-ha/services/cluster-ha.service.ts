import {
  BadRequestException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as k8s from '@kubernetes/client-node';
import { ClusterEntity } from '../../infrastructure/clusters/entities/cluster.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';
import { CapabilitiesProviderFactory } from '../../providers/core/factories/capabilities-provider.factory';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import {
  HaTopology,
  resolveHaTopology,
} from '../../providers/core/ha-topology';
import {
  ClusterHaState,
  clusterHaNodesFrom,
  clusterHaRegion,
  clusterHaState,
  zonesWithServers,
} from '../utils/cluster-ha.core';
import { HaObserved } from '../utils/ha-observed';
import { serverHostOf } from '../../infrastructure/networking/kubeconfig-demotion';
import { KnownApiServer } from '../../infrastructure/clusters/services/api-server-failover.core';

export interface ClusterHaObserved {
  at: string | null;
  etcdLeader: HaObserved['etcdLeader'];
  roundTrips: HaObserved['roundTrips'];
  /** The server Flui talks to the cluster through now. */
  reachedThrough: string | null;
  /** The servers Flui can move to if that one is lost. */
  reachableServers: string[];
}

export interface ThreeLocationCluster {
  cluster: ClusterEntity;
  kubeconfig: string;
  nodes: k8s.V1Node[];
  state: ClusterHaState;
  topology: HaTopology;
}

@Injectable()
export class ClusterHaService {
  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusters: Repository<ClusterEntity>,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
    private readonly capabilities: CapabilitiesProviderFactory,
  ) {}

  /**
   * Read from the nodes as they are now, not from what was asked for. What
   * the sweep measured (etcd leader, round trips) is as of `observed.at`.
   */
  async view(
    clusterId: string,
    force = false,
  ): Promise<
    ClusterHaState & { clusterId: string; observed: ClusterHaObserved }
  > {
    const { cluster, kubeconfig, state } = await this.inspect(clusterId, force);
    const metadata = (cluster.metadata ?? {}) as {
      haObserved?: HaObserved;
      apiServers?: KnownApiServer[];
    };
    const host = serverHostOf(kubeconfig);
    return {
      clusterId,
      ...state,
      observed: {
        at: metadata.haObserved?.at ?? null,
        etcdLeader: metadata.haObserved?.etcdLeader ?? null,
        roundTrips: metadata.haObserved?.roundTrips ?? [],
        reachedThrough:
          metadata.apiServers?.find((s) => s.address === host)?.name ?? null,
        reachableServers: (metadata.apiServers ?? []).map((s) => s.name),
      },
    };
  }

  /**
   * Databases and volumes are made highly available only on a cluster that
   * already survives the loss of a location: two copies of data are no use
   * if the one server that would move the application to them is lost.
   */
  async requireThreeLocations(
    clusterId: string,
    force = false,
  ): Promise<ThreeLocationCluster> {
    const read = await this.inspect(clusterId, force);
    if (read.state.unsupported) {
      throw new BadRequestException(read.state.unsupported);
    }
    if (read.state.level !== 'three-locations' || !read.topology) {
      throw new BadRequestException(
        notThreeLocations(read.cluster.name, read.state),
      );
    }
    return { ...read, topology: read.topology };
  }

  /** The cluster's nodes, the layout that applies to it and where it stands against it. */
  async inspect(
    clusterId: string,
    force = false,
  ): Promise<
    Omit<ThreeLocationCluster, 'topology'> & { topology: HaTopology | null }
  > {
    const cluster = await this.clusters.findOne({ where: { id: clusterId } });
    if (!cluster) throw new NotFoundException(`Cluster ${clusterId} not found`);
    if (!cluster.kubeconfigEncrypted) {
      throw new BadRequestException('This cluster cannot be reached.');
    }
    const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
    const nodes = await this.kubernetes.listNodes(kubeconfig).catch(() => {
      throw new ServiceUnavailableException(
        `Flui could not reach ${cluster.name} to read its nodes. When the cluster has more servers, Flui moves to one that answers within a minute.`,
      );
    });
    const haNodes = clusterHaNodesFrom(nodes);
    const provider = cluster.provider as CloudProvider;
    const declared = this.capabilities.isProviderSupported(provider)
      ? this.capabilities.getCapabilitiesService(provider).haTopologies()
      : [];
    const resolution = resolveHaTopology(
      declared,
      clusterHaRegion(haNodes),
      zonesWithServers(haNodes),
      force,
    );
    return {
      cluster,
      kubeconfig,
      nodes,
      state: clusterHaState(haNodes, resolution),
      topology: resolution.topology,
    };
  }
}

/** Why a cluster is not ready for highly available data, in one sentence. */
export function notThreeLocations(name: string, state: ClusterHaState): string {
  if (state.unsupported) return state.unsupported;
  const roles = state.missing
    .map(
      (m) =>
        `a ${m.role === 'server' ? 'server' : 'node for copies of data'} in ${m.zone}`,
    )
    .join(', ');
  return `${name} is not highly available across three locations yet; it still needs ${roles}. \`flui cluster ha ${name}\` shows where it stands.`;
}
