import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import * as k8s from '@kubernetes/client-node';
import { ApplicationEntity } from '../../../applications/entities/application.entity';
import { ClusterEntity } from '../../clusters/entities/cluster.entity';
import {
  ClusterNodeEntity,
  NodeType,
} from '../../clusters/entities/cluster-node.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';
import { DrainBudget, DrainCheck, DrainPod, checkDrain } from './drain.core';

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
