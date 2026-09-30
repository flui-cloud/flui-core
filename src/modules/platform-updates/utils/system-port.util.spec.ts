import { KubernetesService } from '../../infrastructure/shared/services/kubernetes.service';
import { kubernetesSystemPort } from './system-port.util';

function fakeK8s(items: {
  deployments?: unknown[];
  statefulSets?: unknown[];
  daemonSets?: unknown[];
}): KubernetesService {
  const appsApi = {
    listNamespacedDeployment: async () => ({ items: items.deployments ?? [] }),
    listNamespacedStatefulSet: async () => ({
      items: items.statefulSets ?? [],
    }),
    listNamespacedDaemonSet: async () => ({ items: items.daemonSets ?? [] }),
  };
  return { getKubeClient: () => ({ appsApi }) } as unknown as KubernetesService;
}

describe('kubernetesSystemPort.deployments', () => {
  it('reads Deployments, StatefulSets and DaemonSets alike', async () => {
    const port = kubernetesSystemPort(
      fakeK8s({
        deployments: [
          {
            metadata: { name: 'flui-api' },
            spec: { replicas: 1 },
            status: { availableReplicas: 1 },
          },
        ],
        statefulSets: [
          {
            metadata: { name: 'postgres' },
            spec: { replicas: 1 },
            status: { readyReplicas: 0 },
          },
        ],
        daemonSets: [
          {
            metadata: { name: 'traefik' },
            status: { desiredNumberScheduled: 2, numberAvailable: 2 },
          },
        ],
      }),
      'kubeconfig',
    );

    expect(await port.deployments(['kube-system'])).toEqual([
      { namespace: 'kube-system', name: 'flui-api', available: true },
      { namespace: 'kube-system', name: 'postgres', available: false },
      { namespace: 'kube-system', name: 'traefik', available: true },
    ]);
  });

  it('counts a workload scaled to zero as available', async () => {
    const port = kubernetesSystemPort(
      fakeK8s({
        statefulSets: [
          { metadata: { name: 'idle' }, spec: { replicas: 0 }, status: {} },
        ],
        daemonSets: [
          {
            metadata: { name: 'nowhere' },
            status: { desiredNumberScheduled: 0 },
          },
        ],
      }),
      'kubeconfig',
    );

    expect((await port.deployments(['ns'])).every((w) => w.available)).toBe(
      true,
    );
  });
});
