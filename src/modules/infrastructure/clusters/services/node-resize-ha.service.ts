import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ClusterEntity } from '../entities/cluster.entity';
import { ClusterNodeEntity } from '../entities/cluster-node.entity';
import {
  InfrastructureOperationEntity,
  OperationStatus,
  OperationType,
} from '../../servers/entities/infrastructure-operations.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { ClusterHaService } from '../../../cluster-ha/services/cluster-ha.service';
import { ReplicatedPoolPreparer } from '../../../replicated-volumes/services/replicated-pool.preparer';
import { clusterHaNodesFrom } from '../../../cluster-ha/utils/cluster-ha.core';
import { CNPG_API_VERSION } from '../../../postgres-ha/postgres-ha.constants';
import {
  LINSTOR_CONTROLLER_DEPLOYMENT,
  LINSTOR_CONTROLLER_SELECTOR,
  PIRAEUS_NAMESPACE,
  REPLICATED_POOL_FILE,
  REPLICATED_VOLUME_GROUP,
} from '../../../replicated-volumes/replicated-volumes.constants';
import {
  staleCopyWarnings,
  volumeCopiesFrom,
} from '../../../replicated-volumes/utils/replicated-volumes.core';
import {
  growCopiesScript,
  resizeHaRefusal,
  switchoverTarget,
} from '../utils/node-resize-ha.core';

export interface PlannedSwitchover {
  namespace: string;
  cluster: string;
  target: string;
}

export interface HaResizeReadiness {
  refusal: string | null;
  switchovers: PlannedSwitchover[];
}

/**
 * What resizing a node of a cluster across three locations takes beyond the
 * resize itself: the checks before it, the primaries handed over first, and
 * the space for copies grown once the node is back.
 */
@Injectable()
export class NodeResizeHaService {
  constructor(
    @InjectRepository(InfrastructureOperationEntity)
    private readonly operationRepository: Repository<InfrastructureOperationEntity>,
    private readonly kubernetesService: KubernetesService,
    private readonly clusterHa: ClusterHaService,
    private readonly hostScripts: ReplicatedPoolPreparer,
  ) {}

  /**
   * Null on a cluster that is not across three locations, or that could not
   * be read: the resize then works as it always has.
   */
  async readiness(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
  ): Promise<HaResizeReadiness | null> {
    const ha = await this.clusterHa.inspect(cluster.id).catch(() => null);
    if (ha?.state.level !== 'three-locations' || !ha.topology) return null;
    const nodes = clusterHaNodesFrom(ha.nodes);
    const running = await this.operationRepository
      .createQueryBuilder('op')
      .where('op.operationType = :type', { type: OperationType.SCALE_NODE })
      .andWhere('op.status IN (:...statuses)', {
        statuses: [OperationStatus.PENDING, OperationStatus.IN_PROGRESS],
      })
      .andWhere(`op.metadata ->> 'clusterId' = :clusterId`, {
        clusterId: cluster.id,
      })
      .andWhere('op.resourceId != :nodeId', { nodeId: node.id })
      .getOne();
    const zoneOf = new Map(nodes.map((n) => [n.name, n.zone ?? '']));
    return {
      refusal: resizeHaRefusal({
        clusterName: cluster.name,
        nodeName: node.serverName,
        serversNotReady: nodes
          .filter((n) => n.server && !n.ready)
          .map((n) => n.name),
        otherResizeRunning: running?.resourceName ?? null,
        staleCopies: await this.staleCopies(ha.kubeconfig),
      }),
      switchovers: await this.plannedSwitchovers(
        ha.kubeconfig,
        node.serverName,
        zoneOf,
        ha.topology.dataZones,
      ),
    };
  }

  private async staleCopies(kubeconfig: string): Promise<string[]> {
    try {
      return staleCopyWarnings(
        volumeCopiesFrom(
          await this.kubernetesService.execInPod(
            kubeconfig,
            PIRAEUS_NAMESPACE,
            LINSTOR_CONTROLLER_SELECTOR,
            LINSTOR_CONTROLLER_DEPLOYMENT,
            ['linstor', '-m', '--output-version', 'v1', 'resource', 'list'],
          ),
        ),
        new Map(),
      );
    } catch {
      return [];
    }
  }

  private async plannedSwitchovers(
    kubeconfig: string,
    nodeName: string,
    zoneOf: Map<string, string>,
    preferredZones: string[],
  ): Promise<PlannedSwitchover[]> {
    const clusters = await this.kubernetesService
      .listObjectsEverywhere(kubeconfig, CNPG_API_VERSION, 'Cluster')
      .catch(() => []);
    const planned: PlannedSwitchover[] = [];
    for (const c of clusters) {
      const namespace = c.metadata?.namespace;
      const name = c.metadata?.name;
      if (!namespace || !name) continue;
      const pods = await this.kubernetesService.listPodsByLabel(
        kubeconfig,
        namespace,
        `cnpg.io/cluster=${name}`,
      );
      const target = switchoverTarget({
        primary: c.status?.currentPrimary,
        nodeName,
        instances: pods.map((p) => ({
          name: p.metadata?.name ?? '',
          node: p.spec?.nodeName,
          ready: (p.status?.conditions ?? []).some(
            (cond) => cond.type === 'Ready' && cond.status === 'True',
          ),
        })),
        zoneOf,
        preferredZones,
      });
      if (target) planned.push({ namespace, cluster: name, target });
    }
    return planned;
  }

  /** The same planned switchover CloudNativePG's own plugin asks for; writes pause for seconds. */
  async switchover(kubeconfig: string, s: PlannedSwitchover): Promise<void> {
    await this.kubernetesService.jsonPatchObjectStatus(
      kubeconfig,
      {
        apiVersion: CNPG_API_VERSION,
        plural: 'clusters',
        name: s.cluster,
        namespace: s.namespace,
      },
      [
        { op: 'replace', path: '/status/targetPrimary', value: s.target },
        {
          op: 'replace',
          path: '/status/targetPrimaryTimestamp',
          value: new Date().toISOString(),
        },
        {
          op: 'replace',
          path: '/status/phase',
          value: 'Switchover in progress',
        },
        {
          op: 'replace',
          path: '/status/phaseReason',
          value: `Switching over to ${s.target} before a node is resized`,
        },
      ],
    );
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      const c = await this.kubernetesService.readObject(
        kubeconfig,
        CNPG_API_VERSION,
        'Cluster',
        s.cluster,
        s.namespace,
      );
      if (
        c?.status?.currentPrimary === s.target &&
        c?.status?.phase === 'Cluster in healthy state'
      ) {
        return;
      }
      await new Promise((r) => setTimeout(r, 3000));
    }
    throw new Error(
      `The primary of ${s.namespace}/${s.cluster} did not move to ${s.target} within 3 minutes; the node was left on.`,
    );
  }

  /** A message for the operation, or null on a node that holds no copies. */
  async growCopies(
    kubeconfig: string,
    nodeName: string,
    sizeGiB: number,
  ): Promise<string | null> {
    const output = await this.hostScripts.runHostScript(
      kubeconfig,
      nodeName,
      growCopiesScript(REPLICATED_POOL_FILE, REPLICATED_VOLUME_GROUP, sizeGiB),
    );
    const line =
      output
        .trim()
        .split('\n')
        .find((l) => /^(GROWN|NOSPACE|UNCHANGED|NOPOOL)/.test(l)) ?? '';
    if (line.startsWith('GROWN')) {
      return `Space for copies on ${nodeName} grown to ${line.split(' ')[1]} GiB`;
    }
    if (line.startsWith('NOSPACE')) {
      return `Space for copies on ${nodeName} kept: the disk has not enough room for ${sizeGiB} GiB`;
    }
    if (line.startsWith('UNCHANGED')) {
      return `Space for copies on ${nodeName} already ${sizeGiB} GiB or more`;
    }
    return null;
  }
}
