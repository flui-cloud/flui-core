import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';

export interface SystemDeployment {
  namespace: string;
  name: string;
  available: boolean;
}

/** A Deployment, StatefulSet or DaemonSet: the platform ships all three. */
function workload(
  namespace: string,
  name: string | undefined,
  wanted: number,
  available: number | undefined,
): SystemDeployment {
  return {
    namespace,
    name: name ?? '',
    available: wanted === 0 || (available ?? 0) >= wanted,
  };
}

/** What the checks read on a cluster. */
export interface SystemPort {
  deployments(namespaces: string[]): Promise<SystemDeployment[]>;
  deployment(
    namespace: string,
    name: string,
  ): Promise<{ images: string[]; available: boolean } | null>;
}

export function kubernetesSystemPort(
  k8s: KubernetesService,
  kubeconfig: string,
): SystemPort {
  return {
    deployments: async (namespaces) => {
      const { appsApi } = k8s.getKubeClient(kubeconfig);
      const out: SystemDeployment[] = [];
      for (const namespace of namespaces) {
        const [deployments, statefulSets, daemonSets] = await Promise.all([
          appsApi.listNamespacedDeployment({ namespace }),
          appsApi.listNamespacedStatefulSet({ namespace }),
          appsApi.listNamespacedDaemonSet({ namespace }),
        ]);
        for (const d of deployments.items ?? []) {
          out.push(
            workload(
              namespace,
              d.metadata?.name,
              d.spec?.replicas ?? 1,
              d.status?.availableReplicas,
            ),
          );
        }
        for (const s of statefulSets.items ?? []) {
          out.push(
            workload(
              namespace,
              s.metadata?.name,
              s.spec?.replicas ?? 1,
              s.status?.readyReplicas,
            ),
          );
        }
        for (const d of daemonSets.items ?? []) {
          out.push(
            workload(
              namespace,
              d.metadata?.name,
              d.status?.desiredNumberScheduled ?? 0,
              d.status?.numberAvailable,
            ),
          );
        }
      }
      return out;
    },
    deployment: async (namespace, name) => {
      const { appsApi } = k8s.getKubeClient(kubeconfig);
      const d = await appsApi
        .readNamespacedDeployment({ namespace, name })
        .catch(() => null);
      if (!d) return null;
      const wanted = d.spec?.replicas ?? 1;
      return {
        images: (d.spec?.template?.spec?.containers ?? [])
          .map((c) => c.image ?? '')
          .filter(Boolean),
        available: wanted > 0 && (d.status?.availableReplicas ?? 0) >= wanted,
      };
    },
  };
}
