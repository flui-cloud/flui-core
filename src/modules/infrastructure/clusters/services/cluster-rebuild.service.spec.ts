// The Kubernetes client ships ESM and this project's jest transforms only
// `jose`; every call it would make is stubbed here.
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { ClusterRebuildService } from './cluster-rebuild.service';
import { ClusterStatus, ClusterType } from '../entities/cluster.entity';
import { ApplicationStatus } from '../../../applications/enums/application-status.enum';

/**
 * A rebuild moves every application of a cluster in one go, so what matters is
 * what it refuses. Each test here is a reason not to start.
 */
describe('ClusterRebuildService.plan', () => {
  const cluster = (over: Record<string, unknown> = {}) => ({
    id: 'from-1',
    name: 'workload-lost',
    status: ClusterStatus.READY,
    clusterType: ClusterType.WORKLOAD,
    kubeconfigEncrypted: 'kc',
    ...over,
  });

  const app = (over: Record<string, unknown> = {}) => ({
    id: 'app-1',
    name: 'App One',
    slug: 'app-one',
    status: ApplicationStatus.RUNNING,
    replicas: 1,
    volumes: [],
    resources: { cpu: { request: '250m' }, memory: { limit: '512Mi' } },
    metadata: {},
    ...over,
  });

  function make(opts: {
    from?: Record<string, unknown>;
    to?: Record<string, unknown>;
    apps?: Record<string, unknown>[];
    /** cpu cores / bytes, as getNodeAllocatable reports them */
    allocatable?: { cpu: number; memory: number };
    sourceReachable?: boolean;
  }) {
    const from = cluster({ id: 'from-1', ...(opts.from ?? {}) });
    const to = cluster({
      id: 'to-1',
      name: 'workload-live',
      ...(opts.to ?? {}),
    });

    const service = Object.create(
      ClusterRebuildService.prototype,
    ) as ClusterRebuildService;
    (service as unknown as Record<string, unknown>).logger = {
      log: jest.fn(),
      warn: jest.fn(),
    };
    (service as unknown as Record<string, unknown>).clusterRepo = {
      findOne: jest.fn(async (q: { where: { id: string } }) =>
        q.where.id === 'from-1' ? from : to,
      ),
    };
    (service as unknown as Record<string, unknown>).appRepo = {
      find: jest.fn(async () => (opts.apps ?? [app()]).map((a) => app(a))),
    };
    (service as unknown as Record<string, unknown>).endpointRepo = {};
    (service as unknown as Record<string, unknown>).encryption = {
      decrypt: (v: string) => v,
    };
    (service as unknown as Record<string, unknown>).k8s = {
      getNodeAllocatable: jest.fn(async (kc: string) => {
        // The source is probed with the same call: unreachable means it throws.
        if (kc === 'from-kc' && !opts.sourceReachable) {
          throw new Error('connect ETIMEDOUT');
        }
        return opts.allocatable ?? { cpu: 4, memory: 8 * 1024 ** 3 };
      }),
    };
    return service;
  }

  const lostSource = { kubeconfigEncrypted: 'from-kc' };

  it('allows a rebuild from a cluster that no longer answers', async () => {
    const plan = await make({ from: lostSource }).plan('from-1', 'to-1');

    expect(plan.refusals).toEqual([]);
    expect(plan.apps).toHaveLength(1);
  });

  it('refuses a source that is still reachable', async () => {
    // Still answering means it is not lost, and moving a working cluster
    // drains rather than recreates — a different operation entirely.
    const plan = await make({
      from: lostSource,
      sourceReachable: true,
    }).plan('from-1', 'to-1');

    expect(plan.refusals.join(' ')).toMatch(/still reachable/);
  });

  it('refuses a destination that is not ready', async () => {
    const plan = await make({
      from: lostSource,
      to: { status: ClusterStatus.CREATING },
    }).plan('from-1', 'to-1');

    expect(plan.refusals.join(' ')).toMatch(/not ready/);
  });

  it('refuses the control cluster as a destination', async () => {
    const plan = await make({
      from: lostSource,
      to: { clusterType: ClusterType.CONTROL },
    }).plan('from-1', 'to-1');

    expect(plan.refusals.join(' ')).toMatch(/control cluster/);
  });

  it('refuses rebuilding a cluster onto itself', async () => {
    const service = make({ from: lostSource });
    (service as unknown as Record<string, unknown>).clusterRepo = {
      findOne: jest.fn(async () => cluster({ id: 'same', ...lostSource })),
    };

    const plan = await service.plan('same', 'same');

    expect(plan.refusals.join(' ')).toMatch(/onto itself/);
  });

  it('checks capacity for the whole set, not one application at a time', async () => {
    // Each of these fits alone; together they do not. Discovering that halfway
    // through leaves half a cluster moved.
    const plan = await make({
      from: lostSource,
      apps: [
        {
          id: 'a',
          resources: { cpu: { request: '2' }, memory: { limit: '4Gi' } },
        },
        {
          id: 'b',
          resources: { cpu: { request: '2' }, memory: { limit: '6Gi' } },
        },
      ],
      allocatable: { cpu: 4, memory: 8 * 1024 ** 3 },
    }).plan('from-1', 'to-1');

    expect(plan.refusals.join(' ')).toMatch(/does not have room for all 2/);
    expect(plan.capacity?.fits).toBe(false);
  });

  it('blocks an application pinned to a node the destination lacks', async () => {
    // Left alone it becomes a nodeSelector nothing satisfies, and the pod
    // waits forever rather than failing.
    const plan = await make({
      from: lostSource,
      apps: [{ dedicatedNodeName: 'lost-worker-2' }],
    }).plan('from-1', 'to-1');

    expect(plan.apps[0].blocked).toMatch(/lost-worker-2/);
  });

  it('warns about volumes and about applications that were not running', async () => {
    const plan = await make({
      from: lostSource,
      apps: [
        { volumes: [{ name: 'data' }], status: ApplicationStatus.STOPPED },
      ],
    }).plan('from-1', 'to-1');

    expect(plan.apps[0].warnings.join(' ')).toMatch(/has volumes/);
    expect(plan.apps[0].warnings.join(' ')).toMatch(/not running/);
    // A warning is not a refusal: the person decides.
    expect(plan.apps[0].blocked).toBeUndefined();
  });
});
