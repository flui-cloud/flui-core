import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import * as k8s from '@kubernetes/client-node';

import {
  ClusterEntity,
  ClusterStatus,
} from '../../infrastructure/clusters/entities/cluster.entity';
import {
  ClusterNodeEntity,
  NodeType,
} from '../../infrastructure/clusters/entities/cluster-node.entity';
import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { EncryptionService } from '../../shared/encryption/services/encryption.service';

import { TopologyResponseDto, TopologyClusterDto } from '../dto/topology.dto';
import {
  TopologyAppStatus,
  TopologyHealthStatus,
} from '../enums/topology.enums';
import { buildMockTopology } from '../data/topology.fixtures';
import { validateClusterApps } from '../utils/topology-validation.util';
import {
  ClusterContext,
  FLUI_MANAGED_LABEL_SELECTOR,
  buildAppDto,
  buildClusterDto,
  describeDaemonSet,
  describeDeployment,
  describeStatefulSet,
  mapNodesToServers,
} from './topology-k8s.helper';

const FLUI_MOCK_ENV = 'FLUI_TOPOLOGY_MOCK';

@Injectable()
export class TopologyService {
  private readonly logger = new Logger(TopologyService.name);

  constructor(
    @InjectRepository(ClusterEntity)
    private readonly clusterRepo: Repository<ClusterEntity>,
    @InjectRepository(ClusterNodeEntity)
    private readonly nodeRepo: Repository<ClusterNodeEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
    private readonly configService: ConfigService,
  ) {}

  isMockMode(): boolean {
    return this.configService.get<string>(FLUI_MOCK_ENV) === 'true';
  }

  async buildTopology(): Promise<TopologyResponseDto> {
    if (this.isMockMode()) {
      return buildMockTopology();
    }

    const clusters = await this.clusterRepo.find({
      where: { deletedAt: IsNull() },
      order: { createdAt: 'ASC' },
    });
    // Will not answer, and asking costs the full connect timeout on every poll.
    const reachable = clusters.filter(
      (c) =>
        c.status !== ClusterStatus.LOST && c.status !== ClusterStatus.STOPPED,
    );

    const clusterDtos = await Promise.all(
      reachable.map(async (cluster) => this.buildClusterTopology(cluster)),
    );

    const validClusters = clusterDtos
      .filter((c): c is TopologyClusterDto => c !== null)
      .map(validateClusterApps);

    return assembleResponse(validClusters);
  }

  private async buildClusterTopology(
    cluster: ClusterEntity,
  ): Promise<TopologyClusterDto | null> {
    if (!cluster.kubeconfigEncrypted) {
      this.logger.warn(
        `Skipping cluster ${cluster.id}: no kubeconfig configured`,
      );
      return null;
    }

    const clusterNodes = await this.nodeRepo.find({
      where: { clusterId: cluster.id },
    });
    const controlPlaneNodeNames = new Set(
      clusterNodes
        .filter((n) => n.nodeType === NodeType.MASTER)
        .map((n) => n.serverName),
    );

    const ctx: ClusterContext = {
      id: cluster.id,
      name: cluster.name,
      displayName: cluster.name,
      provider: cluster.provider,
      region: cluster.region,
      controlPlaneNodeNames,
    };

    try {
      const kubeconfig = this.encryptionService.decrypt(
        cluster.kubeconfigEncrypted,
      );
      const { coreApi, appsApi } =
        this.kubernetesService.getKubeClient(kubeconfig);

      const [
        nodesRes,
        deploymentsRes,
        statefulSetsRes,
        daemonSetsRes,
        podsRes,
      ] = await Promise.all([
        coreApi.listNode(),
        appsApi.listDeploymentForAllNamespaces({
          labelSelector: FLUI_MANAGED_LABEL_SELECTOR,
        }),
        appsApi.listStatefulSetForAllNamespaces({
          labelSelector: FLUI_MANAGED_LABEL_SELECTOR,
        }),
        appsApi.listDaemonSetForAllNamespaces({
          labelSelector: FLUI_MANAGED_LABEL_SELECTOR,
        }),
        coreApi.listPodForAllNamespaces({
          labelSelector: FLUI_MANAGED_LABEL_SELECTOR,
        }),
      ]);

      const servers = mapNodesToServers(nodesRes.items ?? [], ctx);
      const serverIds = servers.map((s) => s.id);
      const pods = podsRes.items ?? [];

      const apps = [
        ...(deploymentsRes.items ?? []).map(describeDeployment),
        ...(statefulSetsRes.items ?? []).map(describeStatefulSet),
        ...(daemonSetsRes.items ?? []).map(describeDaemonSet),
      ].map((workload) => {
        const matchingPods = pods.filter(
          (p) =>
            podMatchesSelector(p, workload.selectorMatchLabels) &&
            p.metadata?.namespace === workload.namespace,
        );
        return buildAppDto(workload, matchingPods, serverIds);
      });

      return buildClusterDto(ctx, servers, apps);
    } catch (error) {
      this.logger.error(
        `Failed to build topology for cluster ${cluster.id}: ${(error as Error).message}`,
      );
      return {
        id: ctx.id,
        name: ctx.name,
        displayName: ctx.displayName,
        provider: ctx.provider,
        region: ctx.region,
        status: TopologyHealthStatus.DOWN,
        servers: [],
        apps: [],
      };
    }
  }
}

function podMatchesSelector(
  pod: k8s.V1Pod,
  matchLabels: Record<string, string>,
): boolean {
  const podLabels = pod.metadata?.labels ?? {};
  for (const [k, v] of Object.entries(matchLabels)) {
    if (podLabels[k] !== v) return false;
  }
  return true;
}

function assembleResponse(clusters: TopologyClusterDto[]): TopologyResponseDto {
  let totalServers = 0;
  let totalApps = 0;
  let totalReplicas = 0;
  let totalRamMB = 0;
  let errorCount = 0;
  let warningCount = 0;

  for (const c of clusters) {
    totalServers += c.servers.length;
    totalApps += c.apps.length;
    for (const a of c.apps) {
      totalReplicas += a.replicaCount;
      totalRamMB += a.ramRequestMB * a.replicaCount;
      if (a.status === TopologyAppStatus.ERROR) errorCount++;
      else if (a.status === TopologyAppStatus.WARNING) warningCount++;
    }
  }

  return {
    version: '1',
    fetchedAt: new Date().toISOString(),
    clusters,
    stats: {
      totalClusters: clusters.length,
      totalServers,
      totalApps,
      totalReplicas,
      totalRamMB,
      errorCount,
      warningCount,
    },
  };
}
