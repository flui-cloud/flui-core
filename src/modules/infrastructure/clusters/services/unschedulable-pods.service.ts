import { Injectable, Logger } from '@nestjs/common';
import type * as k8s from '@kubernetes/client-node';
import { ClusterEntity } from '../entities/cluster.entity';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import { EncryptionService } from '../../../shared/encryption/services/encryption.service';

export interface PendingPodRequest {
  name: string;
  namespace: string;
  cpuMillicores: number;
  memoryMi: number;
}

/**
 * How long a cluster gets to answer before it counts as unanswered.
 *
 * Without one the wait is the operating system's TCP timeout — over a minute —
 * and that number is wrong in both places this read is used: it turns a
 * once-a-minute loop into one that cannot keep its own interval, and it leaves a
 * screen showing placeholders for longer than anybody will wait. A cluster that
 * has not answered in six seconds has not answered.
 */
const ASK_TIMEOUT_MS = 6_000;

export interface UnschedulablePods {
  count: number;
  oldestWaitingSeconds: number | null;
  largestRequest: PendingPodRequest | null;
  message: string | null;
}

/**
 * The pods the scheduler could not place.
 *
 * A utilisation percentage answers "how full is the cluster"; this answers
 * "is something already waiting", and the two disagree often enough to matter:
 * a cluster at 60% with a 16Gi pod pending needs a node, one at 95% with
 * everything running may not.
 */
@Injectable()
export class UnschedulablePodsService {
  private readonly logger = new Logger(UnschedulablePodsService.name);

  constructor(
    private readonly kubernetesService: KubernetesService,
    private readonly encryptionService: EncryptionService,
  ) {}

  /**
   * Null when the cluster could not be asked — an unreachable API server is
   * not the same answer as "nothing is waiting", and a caller that cannot tell
   * them apart will report calm during an outage.
   */
  async read(cluster: ClusterEntity): Promise<UnschedulablePods | null> {
    if (!cluster.kubeconfigEncrypted) return null;

    try {
      const kubeconfig = this.encryptionService.decrypt(
        cluster.kubeconfigEncrypted,
      );
      const { coreApi } = this.kubernetesService.getKubeClient(kubeconfig);
      // Filtered by the API server rather than here: on a healthy cluster this
      // comes back empty instead of carrying every pod in every namespace.
      const response = await withTimeout(
        coreApi.listPodForAllNamespaces({
          fieldSelector: 'status.phase=Pending',
        }),
        ASK_TIMEOUT_MS,
      );
      if (!response) {
        this.logger.warn(
          `Pending pods unavailable for cluster ${cluster.id}: no answer in ${ASK_TIMEOUT_MS}ms`,
        );
        return null;
      }
      return this.summarise(response.items ?? [], Date.now());
    } catch (err) {
      this.logger.warn(
        `Pending pods unavailable for cluster ${cluster.id}: ${(err as Error).message}`,
      );
      return null;
    }
  }

  summarise(pods: k8s.V1Pod[], now: number): UnschedulablePods {
    const waiting = pods
      .map((pod) => ({ pod, since: this.unschedulableSince(pod) }))
      .filter(
        (entry): entry is { pod: k8s.V1Pod; since: number | null } =>
          entry.since !== undefined,
      );

    if (!waiting.length) {
      return {
        count: 0,
        oldestWaitingSeconds: null,
        largestRequest: null,
        message: null,
      };
    }

    const stamps = waiting
      .map((entry) => entry.since)
      .filter((since): since is number => since !== null);
    const oldestWaitingSeconds = stamps.length
      ? Math.max(0, Math.round((now - Math.min(...stamps)) / 1000))
      : null;

    const requests = waiting.map((entry) => ({
      pod: entry.pod,
      request: this.requestOf(entry.pod),
    }));
    // Ranked by memory first: it is the dimension a node most often cannot
    // hold, and it is what decides which shape would have to be bought.
    requests.sort(
      (a, b) =>
        b.request.memoryMi - a.request.memoryMi ||
        b.request.cpuMillicores - a.request.cpuMillicores,
    );
    const largest = requests[0];

    return {
      count: waiting.length,
      oldestWaitingSeconds,
      largestRequest: largest.request,
      message: this.schedulingMessage(largest.pod),
    };
  }

  /**
   * When the pod became unplaceable, `null` when it says so without a stamp,
   * `undefined` when it is merely starting — a Pending pod that the scheduler
   * has already assigned is not waiting on capacity.
   */
  private unschedulableSince(pod: k8s.V1Pod): number | null | undefined {
    const condition = this.scheduledCondition(pod);
    if (condition?.reason !== 'Unschedulable') return undefined;
    const at = condition.lastTransitionTime ?? pod.metadata?.creationTimestamp;
    if (!at) return null;
    const stamp = new Date(at).getTime();
    return Number.isFinite(stamp) ? stamp : null;
  }

  private scheduledCondition(pod: k8s.V1Pod): k8s.V1PodCondition | undefined {
    const condition = (pod.status?.conditions ?? []).find(
      (c) => c.type === 'PodScheduled',
    );
    return condition?.status === 'False' ? condition : undefined;
  }

  private schedulingMessage(pod: k8s.V1Pod): string | null {
    return this.scheduledCondition(pod)?.message ?? null;
  }

  /**
   * What the pod asks a node to hold. Init containers run one at a time and
   * before the rest, so the pod needs the larger of the two totals, not their
   * sum — the same arithmetic the scheduler does.
   */
  private requestOf(pod: k8s.V1Pod): PendingPodRequest {
    const sum = (containers: k8s.V1Container[]) =>
      containers.reduce(
        (total, container) => {
          const requests = container.resources?.requests ?? {};
          return {
            cpuMillicores:
              total.cpuMillicores +
              this.kubernetesService.parseCpu(requests['cpu'] ?? '0'),
            memoryMi:
              total.memoryMi +
              this.kubernetesService.parseMemory(requests['memory'] ?? '0'),
          };
        },
        { cpuMillicores: 0, memoryMi: 0 },
      );

    const main = sum(pod.spec?.containers ?? []);
    const init = (pod.spec?.initContainers ?? []).reduce(
      (peak, container) => {
        const one = sum([container]);
        return {
          cpuMillicores: Math.max(peak.cpuMillicores, one.cpuMillicores),
          memoryMi: Math.max(peak.memoryMi, one.memoryMi),
        };
      },
      { cpuMillicores: 0, memoryMi: 0 },
    );

    return {
      name: pod.metadata?.name ?? '',
      namespace: pod.metadata?.namespace ?? '',
      cpuMillicores: Math.max(main.cpuMillicores, init.cpuMillicores),
      memoryMi: Math.max(main.memoryMi, init.memoryMi),
    };
  }
}

/**
 * Null on timeout, which is the same answer as any other failure to ask: the
 * caller already has to tell "could not ask" apart from "nothing is waiting",
 * and a slow cluster is not a quiet one either.
 */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    work
      .then((value) => resolve(value))
      .catch(() => resolve(null))
      .finally(() => clearTimeout(timer));
  });
}
