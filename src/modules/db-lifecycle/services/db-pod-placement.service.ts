import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  ClusterNodeEntity,
  NodeStatus,
  NodeType,
} from '../../infrastructure/clusters/entities/cluster-node.entity';
import { WireGuardPeerService } from '../../infrastructure/networking/services/wireguard-peer.service';
import { DbPodExecService } from './db-pod-exec.service';

export interface PodPlacement {
  appId: string;
  clusterId: string;
  podName: string;
  nodeId: string;
  nodeName: string;
  overlayIp: string;
  imageId?: string;
}

/**
 * Where an install's Postgres pod runs, as Flui knows the node: the k8s node
 * name matched to `serverName`, then the pod's host address matched to the
 * node's addresses. Refuses rather than guesses, and refuses a node that is
 * not live on the Flui network.
 */
@Injectable()
export class DbPodPlacementService {
  constructor(
    private readonly exec: DbPodExecService,
    private readonly k8s: KubernetesService,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodes: Repository<ClusterNodeEntity>,
    private readonly peers: WireGuardPeerService,
  ) {}

  /** Undefined while no pod of the app is running on a node yet. */
  async scheduled(appId: string): Promise<PodPlacement | undefined> {
    const t = await this.exec.resolve(appId);
    const pods = await this.k8s.listPodsByLabel(
      t.kubeconfig,
      t.namespace,
      t.labelSelector,
    );
    const pod = pods.find(
      (p) =>
        p.status?.phase === 'Running' &&
        !p.metadata?.deletionTimestamp &&
        !!p.spec?.nodeName,
    );
    if (!pod) return undefined;
    const nodeName = pod.spec?.nodeName as string;
    const hostIp = pod.status?.hostIP;
    const nodes = await this.nodes.find({ where: { clusterId: t.clusterId } });
    const node =
      nodes.find((n) => n.serverName === nodeName) ??
      (hostIp
        ? nodes.find((n) => n.privateIp === hostIp || n.ipAddress === hostIp)
        : undefined);
    if (!node) {
      throw new BadRequestException(
        `Pod of ${appId} runs on ${nodeName}, which Flui does not know as a node of cluster ${t.clusterId}`,
      );
    }
    const overlay = await this.peers.nodeOverlayFor(node.id);
    if (!overlay?.enrolled) {
      throw new BadRequestException(
        `Node ${node.serverName} is not live on the Flui network; a direct link cannot be built to it`,
      );
    }
    const imageId = pod.status?.containerStatuses?.find(
      (c) => c.name === t.container,
    )?.imageID;
    return {
      appId,
      clusterId: t.clusterId,
      podName: pod.metadata?.name as string,
      nodeId: node.id,
      nodeName,
      overlayIp: overlay.nodeAddress,
      imageId: imageId || undefined,
    };
  }

  /**
   * Every node the destination pod could land on must be live on the Flui
   * network: the workers, or the master when there is none. Checked before
   * anything is installed.
   */
  async assertTargetReady(clusterId: string): Promise<void> {
    const ready = (await this.nodes.find({ where: { clusterId } })).filter(
      (n) => n.status === NodeStatus.READY,
    );
    const workers = ready.filter((n) => n.nodeType === NodeType.WORKER);
    const candidates = workers.length
      ? workers
      : ready.filter((n) => n.nodeType === NodeType.MASTER);
    if (!candidates.length) {
      throw new BadRequestException(
        `Cluster ${clusterId} has no node ready to take the database`,
      );
    }
    const offline: string[] = [];
    for (const node of candidates) {
      const overlay = await this.peers.nodeOverlayFor(node.id);
      if (!overlay?.enrolled) offline.push(node.serverName ?? node.id);
    }
    if (offline.length) {
      throw new BadRequestException(
        `Node ${offline.join(', ')} of cluster ${clusterId} is not live on the Flui network, ` +
          `so a direct link to the new database cannot be built. Wait for the network to ` +
          `reconcile (every 10 minutes) or check it, then start the migration again.`,
      );
    }
  }

  async nodeOfApp(appId: string): Promise<PodPlacement> {
    const placement = await this.scheduled(appId);
    if (!placement) {
      throw new BadRequestException(`No running pod for ${appId}`);
    }
    return placement;
  }
}
