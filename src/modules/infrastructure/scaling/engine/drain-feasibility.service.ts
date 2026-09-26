import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as k8s from '@kubernetes/client-node';
import { ApplicationEntity } from '../../../applications/entities/application.entity';
import {
  ClusterEntity,
  isControlClusterType,
} from '../../clusters/entities/cluster.entity';
import {
  ClusterNodeEntity,
  NodeType,
} from '../../clusters/entities/cluster-node.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import {
  appOfPod,
  podLimit,
  podRequest,
} from '../../clusters/services/unschedulable-pods.service';
import { DrainBudget, DrainCheck, DrainPod, checkDrain } from './drain.core';
import { NODE_RESERVE } from './engine.core';
import { FitCheck, MovingPod, NodeRoom, checkFit } from './fit.core';
import { FleetRoom, NodeRoomInput, fleetRoom } from './room.core';

/**
 * Whether a node can be emptied, answered from the cluster itself.
 *
 * Null when the cluster could not be asked, and never a green light: a
 * replacement that treats an unreachable API server as "nothing in the way"
 * buys the second machine and finds out afterwards.
 */
@Injectable()
export class DrainFeasibilityService {
  private readonly logger = new Logger(DrainFeasibilityService.name);

  constructor(
    @InjectRepository(ApplicationEntity)
    private readonly applications: Repository<ApplicationEntity>,
    private readonly kubernetes: KubernetesService,
    private readonly encryption: EncryptionService,
  ) {}

  async check(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
  ): Promise<DrainCheck | null> {
    const dedicatedApps = await this.dedicatedApps(cluster.id, node);

    if (node.nodeType === NodeType.MASTER) {
      // The one answer that needs no cluster: it is refused by what it is.
      return checkDrain({
        nodeName: node.serverName,
        isMaster: true,
        dedicatedApps,
        pods: [],
        budgets: [],
      });
    }

    if (!cluster.kubeconfigEncrypted) return null;

    try {
      const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
      const kc = this.kubernetes.makeKubeConfig(kubeconfig);
      const coreApi = kc.makeApiClient(k8s.CoreV1Api);
      const policyApi = kc.makeApiClient(k8s.PolicyV1Api);

      const [pods, volumes, budgets] = await Promise.all([
        coreApi.listPodForAllNamespaces({
          fieldSelector: `spec.nodeName=${node.serverName}`,
        }),
        coreApi.listPersistentVolume(),
        policyApi.listPodDisruptionBudgetForAllNamespaces(),
      ]);

      const pinned = pinnedClaims(volumes.items ?? [], node.serverName);

      return checkDrain({
        nodeName: node.serverName,
        isMaster: false,
        dedicatedApps,
        pods: (pods.items ?? []).map((pod) => toDrainPod(pod, pinned)),
        budgets: (budgets.items ?? []).map(toDrainBudget),
      });
    } catch (err) {
      this.logger.warn(
        `Drain feasibility unavailable for ${node.serverName}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Whether what runs on a node would still have somewhere to run without it.
   *
   * Null when the cluster could not be asked, and never a green light — the
   * same rule as the drain check. What moves is what a drain would evict:
   * pods that run on every machine and pods the machine placed itself go with
   * it rather than elsewhere.
   */
  async roomElsewhere(
    cluster: ClusterEntity,
    node: ClusterNodeEntity,
  ): Promise<FitCheck | null> {
    if (!cluster.kubeconfigEncrypted) return null;

    try {
      const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
      const coreApi = this.kubernetes
        .makeKubeConfig(kubeconfig)
        .makeApiClient(k8s.CoreV1Api);

      const [nodes, pods] = await Promise.all([
        coreApi.listNode(),
        coreApi.listPodForAllNamespaces({
          fieldSelector: 'status.phase!=Succeeded,status.phase!=Failed',
        }),
      ]);

      const others = (nodes.items ?? []).filter(
        (item) => item.metadata?.name !== node.serverName,
      );
      // On a control cluster the master is kept free of apps while workers
      // exist and opened up again when the last one leaves, so taking the last
      // worker away is exactly what makes room on the master.
      const reopensMaster =
        isControlClusterType(cluster.clusterType) &&
        others.length === 1 &&
        isControlPlane(others[0]);

      const requested = new Map<string, { cpu: number; memory: number }>();
      const moving: MovingPod[] = [];
      for (const pod of pods.items ?? []) {
        const on = pod.spec?.nodeName;
        if (!on) continue;
        const ask = podRequest(pod, this.kubernetes);
        if (on === node.serverName) {
          if (!stays(pod)) {
            moving.push({
              name: ask.app,
              cpuMillicores: ask.cpuMillicores,
              memoryMi: ask.memoryMi,
            });
          }
          continue;
        }
        const sum = requested.get(on) ?? { cpu: 0, memory: 0 };
        sum.cpu += ask.cpuMillicores;
        sum.memory += ask.memoryMi;
        requested.set(on, sum);
      }

      const rooms: NodeRoom[] = others
        .filter((item) => takesWork(item, reopensMaster))
        .map((item) => {
          const name = item.metadata?.name ?? '';
          const allocatable = item.status?.allocatable ?? {};
          const used = requested.get(name) ?? { cpu: 0, memory: 0 };
          return {
            name,
            cpuMillicores:
              this.kubernetes.parseCpu(allocatable['cpu'] ?? '0') -
              used.cpu -
              NODE_RESERVE.cpuMillicores,
            memoryMi:
              this.kubernetes.parseMemory(allocatable['memory'] ?? '0') -
              used.memory -
              NODE_RESERVE.memoryMi,
          };
        });

      return checkFit(moving, rooms);
    } catch (err) {
      this.logger.warn(
        `Room elsewhere unavailable for ${node.serverName}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * How much each node has left for new apps, as the scheduler counts it.
   *
   * Null when the cluster could not be asked — never an empty fleet.
   */
  async fleetRoom(
    cluster: ClusterEntity,
    releasing: (pod: k8s.V1Pod) => boolean = () => false,
  ): Promise<FleetRoom | null> {
    if (!cluster.kubeconfigEncrypted) return null;
    try {
      const kubeconfig = this.encryption.decrypt(cluster.kubeconfigEncrypted);
      const coreApi = this.kubernetes
        .makeKubeConfig(kubeconfig)
        .makeApiClient(k8s.CoreV1Api);

      const [nodes, pods] = await Promise.all([
        coreApi.listNode(),
        coreApi.listPodForAllNamespaces({
          fieldSelector: 'status.phase!=Succeeded,status.phase!=Failed',
        }),
      ]);

      const requested = new Map<string, { cpu: number; memory: number }>();
      const limited = new Map<string, { cpu: number; memory: number }>();
      const appsOn = new Map<string, Set<string>>();
      for (const pod of pods.items ?? []) {
        const on = pod.spec?.nodeName;
        if (!on || releasing(pod)) continue;
        const ask = podRequest(pod, this.kubernetes);
        const sum = requested.get(on) ?? { cpu: 0, memory: 0 };
        sum.cpu += ask.cpuMillicores;
        sum.memory += ask.memoryMi;
        requested.set(on, sum);
        const cap = podLimit(pod, this.kubernetes);
        const ceiling = limited.get(on) ?? { cpu: 0, memory: 0 };
        ceiling.cpu += cap.cpuMillicores;
        ceiling.memory += cap.memoryMi;
        limited.set(on, ceiling);
        if (pod.metadata?.labels?.['flui-app-id']) {
          const here = appsOn.get(on) ?? new Set<string>();
          here.add(appOfPod(pod));
          appsOn.set(on, here);
        }
      }
      const usage = await this.nodeUsage(kubeconfig);

      const inputs: NodeRoomInput[] = (nodes.items ?? []).map((item) => {
        const name = item.metadata?.name ?? '';
        const allocatable = item.status?.allocatable ?? {};
        const used = requested.get(name) ?? { cpu: 0, memory: 0 };
        return {
          name,
          role: isControlPlane(item) ? 'master' : 'worker',
          takesWork: takesWork(item, false),
          allocatable: {
            cpuMillicores: this.kubernetes.parseCpu(allocatable['cpu'] ?? '0'),
            memoryMi: this.kubernetes.parseMemory(allocatable['memory'] ?? '0'),
          },
          requested: { cpuMillicores: used.cpu, memoryMi: used.memory },
          limits: {
            cpuMillicores: limited.get(name)?.cpu ?? 0,
            memoryMi: limited.get(name)?.memory ?? 0,
          },
          used: usage?.get(name) ?? null,
          apps: [...(appsOn.get(name) ?? [])].sort((a, b) =>
            a < b ? -1 : Number(a > b),
          ),
        };
      });

      return fleetRoom(inputs, NODE_RESERVE);
    } catch (err) {
      this.logger.warn(
        `Fleet room unavailable for ${cluster.name}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async nodeUsage(
    kubeconfig: string,
  ): Promise<Map<string, { cpuMillicores: number; memoryMi: number }> | null> {
    try {
      const metrics = await new k8s.Metrics(
        this.kubernetes.makeKubeConfig(kubeconfig),
      ).getNodeMetrics();
      return new Map(
        (metrics.items ?? []).map((item) => [
          item.metadata?.name ?? '',
          {
            cpuMillicores: this.kubernetes.parseCpu(item.usage?.cpu ?? '0'),
            memoryMi: this.kubernetes.parseMemory(item.usage?.memory ?? '0'),
          },
        ]),
      );
    } catch {
      return null;
    }
  }

  private async dedicatedApps(
    clusterId: string,
    node: ClusterNodeEntity,
  ): Promise<string[]> {
    const where =
      node.nodeType === NodeType.MASTER
        ? { clusterId, persistenceScope: 'dedicated' }
        : {
            clusterId,
            persistenceScope: 'dedicated',
            dedicatedNodeName: node.serverName,
          };
    const rows = await this.applications.find({ where: where as never });
    return rows.map((row) => row.slug);
  }
}

/** Pods that run on every machine, or that the machine itself placed, go with it. */
function stays(pod: k8s.V1Pod): boolean {
  const owner = pod.metadata?.ownerReferences?.[0]?.kind;
  const mirror = Boolean(
    pod.metadata?.annotations?.['kubernetes.io/config.mirror'],
  );
  return owner === 'DaemonSet' || mirror;
}

function isControlPlane(node: k8s.V1Node): boolean {
  const labels = node.metadata?.labels ?? {};
  return (
    'node-role.kubernetes.io/control-plane' in labels ||
    'node-role.kubernetes.io/master' in labels
  );
}

/**
 * A machine that would take evicted work: ready, not cordoned, and not refusing
 * new pods by taint. A taint is read as a refusal whatever it tolerates, which
 * can keep a node that could have gone — the cheaper of the two mistakes.
 */
function takesWork(node: k8s.V1Node, reopensMaster: boolean): boolean {
  if (node.spec?.unschedulable) return false;
  const ready = (node.status?.conditions ?? []).find((c) => c.type === 'Ready');
  if (ready?.status !== 'True') return false;
  const refuses = (node.spec?.taints ?? []).some(
    (taint) => taint.effect === 'NoSchedule' || taint.effect === 'NoExecute',
  );
  return !refuses || (reopensMaster && isControlPlane(node));
}

/** The claims whose volume lives on this machine and does not follow a pod. */
function pinnedClaims(
  volumes: k8s.V1PersistentVolume[],
  nodeName: string,
): Set<string> {
  const pinned = new Set<string>();
  for (const volume of volumes) {
    const claim = volume.spec?.claimRef;
    if (!claim?.namespace || !claim.name) continue;
    if (!boundToNode(volume, nodeName)) continue;
    pinned.add(`${claim.namespace}/${claim.name}`);
  }
  return pinned;
}

function boundToNode(
  volume: k8s.V1PersistentVolume,
  nodeName: string,
): boolean {
  const terms = volume.spec?.nodeAffinity?.required?.nodeSelectorTerms ?? [];
  return terms.some((term) =>
    (term.matchExpressions ?? []).some((expression) =>
      (expression.values ?? []).includes(nodeName),
    ),
  );
}

function toDrainPod(pod: k8s.V1Pod, pinned: Set<string>): DrainPod {
  const namespace = pod.metadata?.namespace ?? '';
  const claims = (pod.spec?.volumes ?? [])
    .map((volume) => volume.persistentVolumeClaim?.claimName)
    .filter((name): name is string => Boolean(name))
    .filter((name) => pinned.has(`${namespace}/${name}`));

  // A hostPath is the machine's own filesystem by definition, so it pins the
  // pod without any volume object saying so.
  const hostPaths = (pod.spec?.volumes ?? [])
    .map((volume) => volume.hostPath?.path)
    .filter((path): path is string => Boolean(path));

  return {
    name: pod.metadata?.name ?? '',
    namespace,
    ownerKind: pod.metadata?.ownerReferences?.[0]?.kind ?? null,
    mirror: Boolean(pod.metadata?.annotations?.['kubernetes.io/config.mirror']),
    boundVolumes: [...claims, ...hostPaths],
    labels: pod.metadata?.labels ?? {},
  };
}

/**
 * A budget selecting by expression is read as covering its whole namespace.
 *
 * Only `matchLabels` is evaluated here, and the choice on the rest is which way
 * to be wrong: a budget wrongly thought to cover nothing lets a drain start
 * that the eviction API will then refuse, halfway through, with a machine
 * already bought.
 */
function toDrainBudget(budget: k8s.V1PodDisruptionBudget): DrainBudget {
  const selector = budget.spec?.selector;
  const byExpression = (selector?.matchExpressions ?? []).length > 0;
  return {
    namespace: budget.metadata?.namespace ?? '',
    name: budget.metadata?.name ?? '',
    selector: byExpression ? {} : (selector?.matchLabels ?? {}),
    disruptionsAllowed: budget.status?.disruptionsAllowed ?? null,
  };
}
