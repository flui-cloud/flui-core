import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';

export interface SystemDeployment {
  namespace: string;
  name: string;
  available: boolean;
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
        const list = await appsApi.listNamespacedDeployment({ namespace });
        for (const d of list.items ?? []) {
          const wanted = d.spec?.replicas ?? 1;
          out.push({
            namespace,
            name: d.metadata?.name ?? '',
            available:
              wanted === 0 || (d.status?.availableReplicas ?? 0) >= wanted,
          });
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
