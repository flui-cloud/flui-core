import { Injectable, Logger } from '@nestjs/common';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { ThreeLocationCluster } from './cluster-ha.service';
import { clusterHaNodesFrom } from '../utils/cluster-ha.core';
import {
  ETCD_MEMBER_ANNOTATION,
  EtcdServer,
  etcdLeaderOf,
  etcdLeaderPlacement,
  etcdMembersOf,
  memberOfServer,
} from '../utils/etcd-leader.core';

/** The etcd release K3s embeds is 3.6; its etcdctl speaks to it. */
export const ETCDCTL_IMAGE = 'quay.io/coreos/etcd:v3.6.16';
const ETCD_TLS_DIR = '/var/lib/rancher/k3s/server/tls/etcd';

const etcdctl = (...args: string[]) => [
  '/usr/local/bin/etcdctl',
  '--endpoints=https://127.0.0.1:2379',
  '--cacert=/etcd/server-ca.crt',
  '--cert=/etcd/client.crt',
  '--key=/etcd/client.key',
  ...args,
];

export interface EtcdLeaderObservation {
  node: string | null;
  zone: string | null;
  /** This check handed leadership to the member on `node`. */
  moved: boolean;
}

/**
 * Brings the etcd leader back to a location for data after a loss handed it
 * to the voting one, where every change to the cluster would wait for the far
 * link. Leadership moves between live members without stopping anything.
 */
@Injectable()
export class EtcdLeaderPlacementService {
  private readonly logger = new Logger(EtcdLeaderPlacementService.name);

  constructor(private readonly kubernetes: KubernetesService) {}

  async check(
    ha: ThreeLocationCluster,
    lastMovedAt?: string,
  ): Promise<EtcdLeaderObservation | null> {
    const preferredZones = ha.topology.dataZones;
    const annotations = new Map(
      ha.nodes.map((n) => [
        n.metadata?.name ?? '',
        n.metadata?.annotations?.[ETCD_MEMBER_ANNOTATION],
      ]),
    );
    const servers: EtcdServer[] = clusterHaNodesFrom(ha.nodes)
      .filter((n) => n.server)
      .map((n) => ({
        node: n.name,
        zone: n.zone,
        ready: n.ready,
        member: annotations.get(n.name),
      }));
    const reader = servers.find(
      (s) => s.ready && s.zone && preferredZones.includes(s.zone),
    );
    if (!reader) return null;
    const status = await this.etcdctl(
      ha.kubeconfig,
      reader.node,
      'endpoint',
      'status',
      '-w',
      'json',
    );
    const memberList = await this.etcdctl(
      ha.kubeconfig,
      reader.node,
      'member',
      'list',
      '-w',
      'json',
    );
    const leader = etcdLeaderOf(status);
    const members = etcdMembersOf(memberList);
    const leaderServer = servers.find(
      (s) => memberOfServer(s, members)?.id === leader,
    );
    const observed: EtcdLeaderObservation = {
      node: leaderServer?.node ?? null,
      zone: leaderServer?.zone ?? null,
      moved: false,
    };
    if (preferredZones.length === ha.topology.zones.length) return observed;
    const decision = etcdLeaderPlacement({
      leader,
      members,
      servers,
      preferredZones,
      lastMovedAt,
      now: Date.now(),
    });
    if (!decision.move) return observed;
    await this.etcdctl(
      ha.kubeconfig,
      decision.leaderNode,
      'move-leader',
      decision.target,
    );
    this.logger.log(
      `[etcd] ${ha.cluster.name}: leader on ${decision.leaderNode} sat in the voting location; handed it to ${decision.targetNode}`,
    );
    return {
      node: decision.targetNode,
      zone: servers.find((s) => s.node === decision.targetNode)?.zone ?? null,
      moved: true,
    };
  }

  private etcdctl(kubeconfig: string, node: string, ...args: string[]) {
    return this.kubernetes.runImageOnNode(kubeconfig, node, {
      image: ETCDCTL_IMAGE,
      command: etcdctl(...args),
      hostDir: ETCD_TLS_DIR,
      mountPath: '/etcd',
      hostNetwork: true,
    });
  }
}
