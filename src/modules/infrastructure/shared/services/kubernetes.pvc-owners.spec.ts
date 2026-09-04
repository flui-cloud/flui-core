/**
 * The two questions a volume copy asks: what must stand down, and what is
 * writing right now. They have different answers and different failure modes.
 *
 * For workloads, the naming rule for a StatefulSet's own volumes is the whole
 * reason the resolver exists, and the part that is easy to get wrong in a way
 * no failure reports: a claim minted from `volumeClaimTemplates` never appears
 * in the pod spec, so a resolver that reads pod volumes finds nothing, pauses
 * nothing, and copies a running database while reporting success.
 *
 * For pods, the trap is the phase filter. `Running` looks like the obvious
 * definition of a writer and silently excludes the two phases where an
 * unnoticed writer lives.
 *
 * The client library ships ESM and this project's jest transforms only `jose`,
 * so it is replaced wholesale. Nothing here reaches it — the method under test
 * only walks the lists `listResources` returns, which is stubbed directly.
 */
jest.mock('@kubernetes/client-node', () => ({
  KubeConfig: class {},
  KubernetesObjectApi: { makeApiClient: () => ({}) },
  PatchStrategy: { MergePatch: 'application/merge-patch+json' },
}));

import { KubernetesService } from './kubernetes.service';

describe('KubernetesService PVC resolvers', () => {
  function withCluster(deployments: any[], statefulSets: any[]) {
    const service: KubernetesService = Object.create(
      KubernetesService.prototype,
    );
    (service as any).listResources = jest.fn(
      async (_kubeconfig: string, kind: string) =>
        kind === 'deployments' ? deployments : statefulSets,
    );
    return service;
  }

  function withPods(
    pods: Array<{ name: string; phase: string; claim: string }>,
  ) {
    const service: KubernetesService = Object.create(
      KubernetesService.prototype,
    );
    (service as any).listResources = jest.fn(async () =>
      pods.map((p) => ({
        metadata: { name: p.name },
        status: { phase: p.phase },
        spec: { volumes: [{ persistentVolumeClaim: { claimName: p.claim } }] },
      })),
    );
    return service;
  }

  const statefulSet = (name: string, template: string, replicas = 1) => ({
    metadata: { name },
    spec: {
      replicas,
      volumeClaimTemplates: [{ metadata: { name: template } }],
    },
  });

  const deployment = (name: string, claim: string, replicas = 1) => ({
    metadata: { name },
    spec: {
      replicas,
      template: {
        spec: { volumes: [{ persistentVolumeClaim: { claimName: claim } }] },
      },
    },
  });

  it('finds a StatefulSet through its volume claim template', async () => {
    const service = withCluster([], [statefulSet('postgres', 'data', 3)]);

    await expect(
      service.findWorkloadsMountingPvc('kc', 'ns', 'data-postgres-0'),
    ).resolves.toEqual([
      { kind: 'StatefulSet', name: 'postgres', replicas: 3 },
    ]);
  });

  it('finds a Deployment through a claim named in its pod spec', async () => {
    const service = withCluster([deployment('web', 'uploads', 2)], []);

    await expect(
      service.findWorkloadsMountingPvc('kc', 'ns', 'uploads'),
    ).resolves.toEqual([{ kind: 'Deployment', name: 'web', replicas: 2 }]);
  });

  it('reports a workload already scaled to zero, with its zero', async () => {
    // The pod-walking alternative returns nothing here, which reads as "no
    // workload holds this volume" — the opposite of the truth.
    const service = withCluster([], [statefulSet('postgres', 'data', 0)]);

    await expect(
      service.findWorkloadsMountingPvc('kc', 'ns', 'data-postgres-0'),
    ).resolves.toEqual([
      { kind: 'StatefulSet', name: 'postgres', replicas: 0 },
    ]);
  });

  it('does not mistake another set’s claim for its own', async () => {
    // `data-postgres-replica-0` starts with `data-postgres-` and would match a
    // prefix test that did not require the remainder to be an ordinal.
    const service = withCluster([], [statefulSet('postgres', 'data')]);

    await expect(
      service.findWorkloadsMountingPvc('kc', 'ns', 'data-postgres-replica-0'),
    ).resolves.toEqual([]);
  });

  it('returns every mounting workload when a volume is shared', async () => {
    const service = withCluster(
      [deployment('web', 'shared'), deployment('worker', 'shared')],
      [],
    );

    await expect(
      service.findWorkloadsMountingPvc('kc', 'ns', 'shared'),
    ).resolves.toHaveLength(2);
  });

  it('counts a Pending pod, whose init containers are writing', async () => {
    // `initdb`, a migration, or a recursive chown all run here. Counting only
    // Running pods reports zero writers while the volume is being written.
    const service = withPods([
      { name: 'postgres-0', phase: 'Pending', claim: 'data-postgres-0' },
    ]);

    await expect(
      service.findPodsMountingPvc('kc', 'ns', 'data-postgres-0'),
    ).resolves.toEqual(['postgres-0']);
  });

  it('counts an Unknown pod, whose container is probably still writing', async () => {
    // The kubelet cannot be reached; the process on the node keeps going.
    const service = withPods([
      { name: 'postgres-0', phase: 'Unknown', claim: 'data-postgres-0' },
    ]);

    await expect(
      service.findPodsMountingPvc('kc', 'ns', 'data-postgres-0'),
    ).resolves.toEqual(['postgres-0']);
  });

  it('ignores pods that have finished', async () => {
    const service = withPods([
      { name: 'migrate-1', phase: 'Succeeded', claim: 'data-postgres-0' },
      { name: 'migrate-2', phase: 'Failed', claim: 'data-postgres-0' },
    ]);

    await expect(
      service.findPodsMountingPvc('kc', 'ns', 'data-postgres-0'),
    ).resolves.toEqual([]);
  });

  it('ignores a live pod holding a different claim', async () => {
    const service = withPods([
      { name: 'web-0', phase: 'Running', claim: 'uploads' },
    ]);

    await expect(
      service.findPodsMountingPvc('kc', 'ns', 'data-postgres-0'),
    ).resolves.toEqual([]);
  });

  it('is empty when nothing mounts the claim', async () => {
    const service = withCluster([deployment('web', 'other')], []);

    await expect(
      service.findWorkloadsMountingPvc('kc', 'ns', 'uploads'),
    ).resolves.toEqual([]);
  });
});
