import { Injectable, Logger } from '@nestjs/common';
import * as k8s from '@kubernetes/client-node';
import { KubernetesService } from '../../shared/services/kubernetes.service';
import {
  MasterEvacuation,
  planMasterEvacuation,
} from './master-evacuation.core';

@Injectable()
export class MasterEvacuationService {
  private readonly logger = new Logger(MasterEvacuationService.name);

  constructor(private readonly kubernetes: KubernetesService) {}

  /** Restarts what may leave the reserved master, so the scheduler places it on a worker. */
  async moveOff(kubeconfig: string): Promise<MasterEvacuation> {
    const kc = this.kubernetes.makeKubeConfig(kubeconfig);
    const coreApi = kc.makeApiClient(k8s.CoreV1Api);
    const appsApi = kc.makeApiClient(k8s.AppsV1Api);
    const [nodes, pods, replicaSets] = await Promise.all([
      coreApi.listNode(),
      coreApi.listPodForAllNamespaces({
        fieldSelector: 'status.phase!=Succeeded,status.phase!=Failed',
      }),
      appsApi.listReplicaSetForAllNamespaces(),
    ]);

    const plan = planMasterEvacuation({
      nodes: nodes.items ?? [],
      pods: pods.items ?? [],
      replicaSets: replicaSets.items ?? [],
      parse: this.kubernetes,
    });

    for (const ref of plan.move) {
      try {
        await this.kubernetes.restartWorkload(
          kubeconfig,
          'Deployment',
          ref.namespace,
          ref.name,
        );
      } catch (err) {
        this.logger.warn(
          `Could not move ${ref.namespace}/${ref.name} off the master: ${(err as Error).message}`,
        );
      }
    }
    return plan;
  }
}
