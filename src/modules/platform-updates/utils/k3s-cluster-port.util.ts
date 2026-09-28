import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import {
  K3sClusterPort,
  K3sJobView,
  K3sNodeView,
} from '../interfaces/k3s-upgrade.interface';
import {
  AGENT_PLAN,
  PLAN_CRD,
  SERVER_PLAN,
  SUC_DEPLOYMENT,
  SUC_NAMESPACE,
} from './k3s-plans.util';

/** The nodes, upgrade Jobs, controller and Plans of one cluster, over its API. */
export function kubernetesK3sClusterPort(
  k8s: KubernetesService,
  kubeconfig: string,
): K3sClusterPort {
  return {
    nodes: async (): Promise<K3sNodeView[]> => {
      const { coreApi } = k8s.getKubeClient(kubeconfig);
      const list = await coreApi.listNode();
      return (list.items ?? []).map((n) => {
        const labels = n.metadata?.labels ?? {};
        return {
          name: n.metadata?.name ?? '',
          server:
            labels['node-role.kubernetes.io/control-plane'] === 'true' ||
            labels['node-role.kubernetes.io/master'] === 'true',
          kubeletVersion: n.status?.nodeInfo?.kubeletVersion ?? null,
          ready: (n.status?.conditions ?? []).some(
            (c) => c.type === 'Ready' && c.status === 'True',
          ),
        };
      });
    },
    jobs: async (): Promise<K3sJobView[]> => {
      const { batchApi } = k8s.getKubeClient(kubeconfig);
      const list = await batchApi.listNamespacedJob({
        namespace: SUC_NAMESPACE,
        labelSelector: `upgrade.cattle.io/plan in (${SERVER_PLAN},${AGENT_PLAN})`,
      });
      return (list.items ?? []).map((j) => {
        const labels = j.metadata?.labels ?? {};
        const failed = (j.status?.conditions ?? []).find(
          (c) => c.type === 'Failed' && c.status === 'True',
        );
        return {
          name: j.metadata?.name ?? '',
          plan: labels['upgrade.cattle.io/plan'] ?? '',
          node: labels['upgrade.cattle.io/node'] ?? '',
          version: labels['upgrade.cattle.io/version'] ?? null,
          active: (j.status?.active ?? 0) > 0,
          failed: Boolean(failed),
          message: failed?.message ?? failed?.reason,
          createdAt: j.metadata?.creationTimestamp
            ? new Date(j.metadata.creationTimestamp).toISOString()
            : '',
        };
      });
    },
    controller: async () => {
      const crd = await k8s.readObject(
        kubeconfig,
        'apiextensions.k8s.io/v1',
        'CustomResourceDefinition',
        PLAN_CRD,
      );
      const deployment = await k8s.readObject(
        kubeconfig,
        'apps/v1',
        'Deployment',
        SUC_DEPLOYMENT,
        SUC_NAMESPACE,
      );
      return {
        installed: Boolean(crd) && Boolean(deployment),
        ready: (deployment?.status?.readyReplicas ?? 0) > 0,
      };
    },
    deletePlans: async () => {
      for (const name of [SERVER_PLAN, AGENT_PLAN]) {
        await k8s.deleteObject(
          kubeconfig,
          'upgrade.cattle.io/v1',
          'Plan',
          name,
          SUC_NAMESPACE,
        );
      }
    },
    applyPlans: async (plans) => {
      for (const plan of plans) {
        const existing = await k8s.readObject(
          kubeconfig,
          plan.apiVersion,
          plan.kind,
          plan.metadata.name,
          plan.metadata.namespace,
        );
        if (existing) {
          await k8s.mergePatchObject(kubeconfig, {
            apiVersion: plan.apiVersion,
            kind: plan.kind,
            metadata: {
              name: plan.metadata.name,
              namespace: plan.metadata.namespace,
              labels: plan.metadata.labels,
            },
            spec: plan.spec,
          });
        } else {
          await k8s.createObject(
            kubeconfig,
            plan as unknown as Record<string, unknown>,
          );
        }
      }
    },
  };
}
