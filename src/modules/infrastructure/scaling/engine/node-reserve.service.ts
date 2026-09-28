import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { ClusterEntity } from '../../clusters/entities/cluster.entity';
import { ClusterNodeEntity } from '../../clusters/entities/cluster-node.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { withTimeout } from '../../shared/utils/with-timeout.util';
import { podRequest } from '../../clusters/services/unschedulable-pods.service';
import { NodeReserve, ShapeFact } from './engine.core';
import { NodeOverhead, measuredReserve } from './reserve.core';

const ASK_TIMEOUT_MS = 6_000;
const HOLD_MS = 10 * 60 * 1000;
const HOLD_FAILED_MS = 2 * 60 * 1000;

interface Held {
  reserve: NodeReserve | null;
  until: number;
}

/**
 * The share of a new node the system takes, measured on the cluster.
 *
 * Held for minutes: it changes when the platform changes, not from one pass to
 * the next, and asking the cluster twice a minute for the same figure would add
 * a second slow read to every pass on a cluster that answers slowly. Null when
 * the cluster could not be asked; the caller then uses the fixed reserve.
 */
@Injectable()
export class NodeReserveService {
  private readonly logger = new Logger(NodeReserveService.name);
  private readonly held = new Map<string, Held>();

  constructor(
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
  ) {}

  async read(
    cluster: ClusterEntity,
    rows: Pick<ClusterNodeEntity, 'serverName' | 'serverType'>[],
    facts: ShapeFact[],
  ): Promise<NodeReserve | null> {
    const held = this.held.get(cluster.id);
    if (held && held.until > Date.now()) return held.reserve;

    const reserve = await withTimeout(
      this.measure(cluster, rows, facts),
      ASK_TIMEOUT_MS,
    );
    this.held.set(cluster.id, {
      reserve,
      until: Date.now() + (reserve ? HOLD_MS : HOLD_FAILED_MS),
    });
    return reserve;
  }

  private async measure(
    cluster: ClusterEntity,
    rows: Pick<ClusterNodeEntity, 'serverName' | 'serverType'>[],
    facts: ShapeFact[],
  ): Promise<NodeReserve | null> {
    if (!cluster.kubeconfigEncrypted) return null;
    try {
      const coreApi = this.kubernetes
        .makeKubeConfig(this.encryption.decrypt(cluster.kubeconfigEncrypted))
        .makeApiClient(k8s.CoreV1Api);
      const [nodes, pods] = await Promise.all([
        coreApi.listNode(),
        coreApi.listPodForAllNamespaces({
          fieldSelector: 'status.phase!=Succeeded,status.phase!=Failed',
        }),
      ]);
      const everyNode = new Map<string, NodeReserve>();
      for (const pod of pods.items ?? []) {
        const on = pod.spec?.nodeName;
        if (!on || !onEveryNode(pod)) continue;
        const ask = podRequest(pod, this.kubernetes);
        const sum = everyNode.get(on) ?? { cpuMillicores: 0, memoryMi: 0 };
        sum.cpuMillicores += ask.cpuMillicores;
        sum.memoryMi += ask.memoryMi;
        everyNode.set(on, sum);
      }
      const overheads: NodeOverhead[] = (nodes.items ?? []).map((item) => {
        const name = item.metadata?.name ?? '';
        const shape = rows.find((row) => row.serverName === name)?.serverType;
        const fact = shape ? facts.find((f) => f.shape === shape) : undefined;
        return {
          role: isControlPlane(item) ? 'master' : 'worker',
          nominal: fact
            ? { cpuMillicores: fact.cores * 1000, memoryMi: fact.memoryMi }
            : null,
          capacity: this.amount(item.status?.capacity),
          allocatable: this.amount(item.status?.allocatable),
          everyNode: everyNode.get(name) ?? { cpuMillicores: 0, memoryMi: 0 },
        };
      });
      return overheads.length ? measuredReserve(overheads) : null;
    } catch (err) {
      this.logger.warn(
        `System reserve unavailable for ${cluster.name}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private amount(quantities?: Record<string, string>): NodeReserve {
    return {
      cpuMillicores: this.kubernetes.parseCpu(quantities?.['cpu'] ?? '0'),
      memoryMi: this.kubernetes.parseMemory(quantities?.['memory'] ?? '0'),
    };
  }
}

function onEveryNode(pod: k8s.V1Pod): boolean {
  const owner = pod.metadata?.ownerReferences?.[0]?.kind;
  return (
    owner === 'DaemonSet' ||
    Boolean(pod.metadata?.annotations?.['kubernetes.io/config.mirror'])
  );
}

function isControlPlane(node: k8s.V1Node): boolean {
  const labels = node.metadata?.labels ?? {};
  return (
    'node-role.kubernetes.io/control-plane' in labels ||
    'node-role.kubernetes.io/master' in labels
  );
}
