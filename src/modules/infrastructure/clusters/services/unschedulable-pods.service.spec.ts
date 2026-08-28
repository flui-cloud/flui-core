// Same reason as `clusters.controller.fence.spec.ts`: `KubernetesService`
// imports an ESM-only package ts-jest cannot transform, and nothing here calls
// through it — only its resource-string parsing.
jest.mock('@kubernetes/client-node', () => ({}));

import type * as k8s from '@kubernetes/client-node';
import { UnschedulablePodsService } from './unschedulable-pods.service';
import { KubernetesService } from '../../shared/services/kubernetes.service';

const NOW = Date.parse('2026-08-27T12:00:00Z');

const pod = (over: {
  name?: string;
  namespace?: string;
  cpu?: string;
  memory?: string;
  init?: Array<{ cpu: string; memory: string }>;
  reason?: string;
  message?: string;
  since?: string | null;
  status?: string;
}): k8s.V1Pod =>
  ({
    metadata: {
      name: over.name ?? 'checkout-api-1',
      namespace: over.namespace ?? 'apps',
      creationTimestamp: new Date(NOW - 60_000),
    },
    spec: {
      containers: [
        {
          name: 'main',
          resources: {
            requests: { cpu: over.cpu ?? '500m', memory: over.memory ?? '4Gi' },
          },
        },
      ],
      initContainers: (over.init ?? []).map((c, i) => ({
        name: `init-${i}`,
        resources: { requests: { cpu: c.cpu, memory: c.memory } },
      })),
    },
    status: {
      phase: 'Pending',
      conditions: [
        {
          type: 'PodScheduled',
          status: over.status ?? 'False',
          reason: over.reason ?? 'Unschedulable',
          message:
            over.message ?? '0/1 nodes are available: 1 Insufficient memory.',
          ...(over.since === null
            ? {}
            : { lastTransitionTime: new Date(over.since ?? NOW - 34_000) }),
        },
      ],
    },
  }) as unknown as k8s.V1Pod;

describe('UnschedulablePodsService.summarise', () => {
  const kubernetes = new KubernetesService();
  const service = new UnschedulablePodsService(kubernetes, {} as never);

  it('reports nothing waiting on an empty list', () => {
    expect(service.summarise([], NOW)).toEqual({
      count: 0,
      oldestWaitingSeconds: null,
      largestRequest: null,
      message: null,
    });
  });

  /*
   * A Pending pod the scheduler has already placed is starting, not waiting on
   * capacity — counting it would raise an alarm about an image pull.
   */
  it('ignores a pending pod that is not unschedulable', () => {
    const result = service.summarise(
      [pod({ status: 'True', reason: undefined })],
      NOW,
    );
    expect(result.count).toBe(0);
  });

  it('ignores a pod held back for a reason other than placement', () => {
    const result = service.summarise([pod({ reason: 'SchedulerError' })], NOW);
    expect(result.count).toBe(0);
  });

  it('counts what cannot be placed and how long the oldest has waited', () => {
    const result = service.summarise(
      [
        pod({ name: 'a', since: '2026-08-27T11:59:26Z' }),
        pod({ name: 'b', since: '2026-08-27T11:50:00Z' }),
      ],
      NOW,
    );

    expect(result.count).toBe(2);
    expect(result.oldestWaitingSeconds).toBe(600);
  });

  it('names the largest request, ranked on memory then CPU', () => {
    const result = service.summarise(
      [
        pod({ name: 'small', cpu: '2', memory: '1Gi' }),
        pod({ name: 'big', namespace: 'batch', cpu: '500m', memory: '16Gi' }),
      ],
      NOW,
    );

    expect(result.largestRequest).toEqual({
      name: 'big',
      namespace: 'batch',
      cpuMillicores: 500,
      memoryMi: 16384,
    });
  });

  it('breaks a memory tie on CPU', () => {
    const result = service.summarise(
      [
        pod({ name: 'lean', cpu: '250m', memory: '4Gi' }),
        pod({ name: 'wide', cpu: '3', memory: '4Gi' }),
      ],
      NOW,
    );

    expect(result.largestRequest?.name).toBe('wide');
  });

  /*
   * Init containers run one at a time and before the rest, so a pod needs the
   * larger of the two totals — summing them would ask for a node nobody needs.
   */
  it('takes the larger of the init peak and the container sum', () => {
    const result = service.summarise(
      [
        pod({
          cpu: '500m',
          memory: '1Gi',
          init: [
            { cpu: '100m', memory: '8Gi' },
            { cpu: '100m', memory: '2Gi' },
          ],
        }),
      ],
      NOW,
    );

    expect(result.largestRequest).toMatchObject({
      cpuMillicores: 500,
      memoryMi: 8192,
    });
  });

  it("carries the scheduler's own account of the refusal", () => {
    const result = service.summarise(
      [pod({ message: '0/3 nodes are available: 3 Insufficient cpu.' })],
      NOW,
    );

    expect(result.message).toBe('0/3 nodes are available: 3 Insufficient cpu.');
  });

  it('still counts a pod whose condition carries no stamp', () => {
    const result = service.summarise([pod({ since: null })], NOW);

    expect(result.count).toBe(1);
    expect(result.oldestWaitingSeconds).toBe(60);
  });
});

describe('UnschedulablePodsService.read', () => {
  /*
   * Null, not zero: an unreachable API server must never be reported as a
   * cluster with nothing waiting.
   */
  it('answers null when the cluster holds no kubeconfig', async () => {
    const service = new UnschedulablePodsService({} as never, {} as never);
    await expect(service.read({ id: 'c-1' } as never)).resolves.toBeNull();
  });

  it('answers null when the cluster cannot be reached', async () => {
    const service = new UnschedulablePodsService(
      {
        getKubeClient: () => {
          throw new Error('connection refused');
        },
      } as never,
      { decrypt: () => 'kubeconfig' } as never,
    );

    await expect(
      service.read({ id: 'c-1', kubeconfigEncrypted: 'x' } as never),
    ).resolves.toBeNull();
  });

  it('asks the API server for pending pods only', async () => {
    const listPodForAllNamespaces = jest.fn().mockResolvedValue({ items: [] });
    const service = new UnschedulablePodsService(
      {
        getKubeClient: () => ({ coreApi: { listPodForAllNamespaces } }),
      } as never,
      { decrypt: () => 'kubeconfig' } as never,
    );

    const result = await service.read({
      id: 'c-1',
      kubeconfigEncrypted: 'x',
    } as never);

    expect(listPodForAllNamespaces).toHaveBeenCalledWith({
      fieldSelector: 'status.phase=Pending',
    });
    expect(result?.count).toBe(0);
  });
});
