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
    /** millicores / MiB, which is what getNodeAllocatable reports */
    allocatable?: { cpu: number; memory: number };
    /** millicores / MiB already asked for by pods on the destination */
    requested?: { cpu: number; memory: number };
    sourceReachable?: boolean;
    /** The source neither answers nor refuses — packets go nowhere. */
    sourceSilent?: boolean;
    /** What the restorer says each application's data will do. */
    preview?: Array<{
      kind: string;
      what: string;
      why?: string;
      from?: string;
    }>;
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
    (service as unknown as Record<string, unknown>).endpointReconciliation = {
      releaseDnsRecord: jest.fn(async () => undefined),
      reconcile: jest.fn(async () => undefined),
    };
    (service as unknown as Record<string, unknown>).dataRestorer = {
      preview: jest.fn(async () => opts.preview ?? []),
    };
    (service as unknown as Record<string, unknown>).encryption = {
      decrypt: (v: string) => v,
    };
    (service as unknown as Record<string, unknown>).k8s = {
      getNodeAllocatable: jest.fn(async (kc: string) => {
        // The source is probed with the same call: unreachable means it throws.
        if (kc === 'from-kc' && opts.sourceSilent) {
          // A powered-off host swallows the packets rather than refusing, and
          // the kernel takes minutes to give up. Never resolves, like the real
          // one — measured at 133 seconds against a cluster stopped at Hetzner.
          return new Promise(() => {}) as never;
        }
        if (kc === 'from-kc' && !opts.sourceReachable) {
          throw new Error('connect ETIMEDOUT');
        }
        return opts.allocatable ?? { cpu: 4000, memory: 8192 };
      }),
      getPodResourceRequests: jest.fn(
        async () => opts.requested ?? { cpu: 0, memory: 0 },
      ),
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
      allocatable: { cpu: 4000, memory: 8192 },
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

  it('warns about applications that were not running', async () => {
    const plan = await make({
      from: lostSource,
      apps: [
        { volumes: [{ name: 'data' }], status: ApplicationStatus.STOPPED },
      ],
    }).plan('from-1', 'to-1');

    expect(plan.apps[0].warnings.join(' ')).toMatch(/not running/);
    // A warning is not a refusal: the person decides.
    expect(plan.apps[0].blocked).toBeUndefined();
  });

  it('says what each volume will actually come back with', async () => {
    // The plan and the rebuild ask the same code, so the warning is what will
    // happen rather than a guess about it. A plan that said "has volumes: it
    // comes back with its last copy, or empty" was true of every application
    // and told nobody which one they had.
    const plan = await make({
      from: lostSource,
      apps: [{ volumes: [{ name: 'data' }, { name: 'uploads' }] }],
      preview: [
        { kind: 'volume', what: 'data' },
        {
          kind: 'empty',
          what: 'uploads',
          why: 'no object-store copy has been taken, so it comes back empty',
        },
      ],
    }).plan('from-1', 'to-1');

    const warnings = plan.apps[0].warnings.join(' ');
    expect(warnings).toMatch(/uploads: no object-store copy/);
    expect(warnings).not.toMatch(/data:/);
  });

  it('warns when the node-local class has to exist on the destination', async () => {
    // `flui-local` is installed by a bootstrap step that only warns on
    // failure, and a claim asking for a class that is not there stays Pending
    // for as long as anybody waits.
    const plan = await make({
      from: lostSource,
      apps: [{ persistenceScope: 'dedicated' }],
    }).plan('from-1', 'to-1');

    expect(plan.apps[0].warnings.join(' ')).toMatch(/flui-local/);
  });

  it('resumes from where a previous run left each application', async () => {
    // Written under `metadata.rebuild.phase` and read from the same place: an
    // earlier version read `metadata.rebuildPhase`, so the plan showed every
    // application as untouched however far a previous run had got.
    const plan = await make({
      from: lostSource,
      apps: [{ metadata: { rebuild: { phase: 'restored' } } }],
    }).plan('from-1', 'to-1');

    expect(plan.apps[0].phase).toBe('restored');
  });

  it('reads the destination in the units the cluster reports', async () => {
    // `getNodeAllocatable` answers in millicores and MiB. Converting them a
    // second time read a 2-core node as 2000000m and a 3.7Gi one as 0Mi, so
    // every rebuild was refused for want of memory the destination had — seen
    // against a live cluster, not reasoned about.
    const plan = await make({
      from: lostSource,
      apps: [
        { resources: { cpu: { request: '250m' }, memory: { limit: '2Gi' } } },
      ],
      allocatable: { cpu: 2000, memory: 3700 },
    }).plan('from-1', 'to-1');

    expect(plan.capacity?.availableCpuMillis).toBe(2000);
    expect(plan.capacity?.availableMemoryMi).toBe(3700);
    expect(plan.capacity?.fits).toBe(true);
  });

  it('counts the room, not the size — what pods already ask for is gone', async () => {
    const plan = await make({
      from: lostSource,
      apps: [
        { resources: { cpu: { request: '250m' }, memory: { limit: '2Gi' } } },
      ],
      allocatable: { cpu: 2000, memory: 3700 },
      requested: { cpu: 900, memory: 2400 },
    }).plan('from-1', 'to-1');

    expect(plan.capacity?.availableMemoryMi).toBe(1300);
    expect(plan.capacity?.fits).toBe(false);
  });

  it('says what comes back as plainly as what does not', async () => {
    // Silence used to mean both "this is restored" and "this application has
    // no data", on the one screen where telling them apart is the question.
    const plan = await make({
      from: lostSource,
      apps: [{ volumes: [{ name: 'data' }] }],
      preview: [{ kind: 'volume', what: 'data', from: 'flui/cl/app/2026' }],
    }).plan('from-1', 'to-1');

    expect(plan.apps[0].restores).toEqual(['data: from flui/cl/app/2026']);
    expect(plan.apps[0].warnings).toEqual([]);
  });

  it('answers even when the source swallows the connection', async () => {
    // The case the probe exists for is the case it used to hang on: the plan
    // took 133 seconds against a stopped cluster and the CLI gave up at 30,
    // so the one command a recovery starts with could not be run.
    jest.useFakeTimers();
    const planning = make({
      from: lostSource,
      sourceSilent: true,
    }).plan('from-1', 'to-1');
    await jest.advanceTimersByTimeAsync(21_000);
    const plan = await planning;
    jest.useRealTimers();

    expect(plan.refusals).toEqual([]);
    expect(plan.warnings.join(' ')).toMatch(/did not answer within 20/);
  });

  it('does not present silence as proof the source is gone', async () => {
    // A control plane cut off from a workload cluster sees exactly this while
    // the applications there keep running and keep writing. Rebuilding then
    // makes a second live copy of each, so the plan says so out loud rather
    // than letting the empty refusals list imply safety.
    jest.useFakeTimers();
    const planning = make({
      from: lostSource,
      sourceSilent: true,
    }).plan('from-1', 'to-1');
    await jest.advanceTimersByTimeAsync(21_000);
    const plan = await planning;
    jest.useRealTimers();

    expect(plan.warnings.join(' ')).toMatch(/still running and still writing/);
  });

  it('says nothing extra when the source refuses outright', async () => {
    // A refused connection is proof; only silence is ambiguous.
    const plan = await make({ from: lostSource }).plan('from-1', 'to-1');

    expect(plan.refusals).toEqual([]);
    expect(plan.warnings).toEqual([]);
  });
});
