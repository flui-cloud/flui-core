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
    const listed = (opts.apps ?? [app()]).map((a) => app(a));
    (service as unknown as Record<string, unknown>).appRepo = {
      find: jest.fn(async () => listed),
      // The plan builds its list with a query builder now: an application is
      // listed when it is still on the source OR carries a ledger naming this
      // destination, so a half-finished rebuild can be resumed.
      createQueryBuilder: jest.fn(() => {
        const qb: Record<string, unknown> = {};
        for (const m of ['where', 'orWhere', 'orderBy']) {
          qb[m] = jest.fn(() => qb);
        }
        qb.getMany = jest.fn(async () => listed);
        return qb;
      }),
    };
    (service as unknown as Record<string, unknown>).zoneAssignmentRepo = {
      findOne: jest.fn(async () => null),
    };
    (service as unknown as Record<string, unknown>).endpointMode = {
      generateFqdn: jest.fn(() => 'derived.example.com'),
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

/**
 * Through `rebuildOne`, never through the classifier alone. The defect these
 * cover is an ordering one — a check reading a column an earlier phase already
 * wrote — and it is invisible to any test that calls the check on untouched
 * rows. So the fakes here mutate for real, and `generateFqdn` computes from its
 * arguments instead of answering by call order: a classifier handed the wrong
 * cluster must produce the wrong answer, or the test proves nothing.
 */
describe('ClusterRebuildService endpoint naming, through a rebuild', () => {
  const ZONE = 'example.com';

  function harness(opts: {
    endpoints: Record<string, unknown>[];
    ledger?: Record<string, unknown>;
    /** Zone assignments, by id. Omit the destination's to strand the names. */
    zones?: Record<string, { clusterId: string; zoneName: string }>;
  }) {
    const from = {
      id: 'from-1',
      name: 'workload-lost',
      masterIpAddress: '10.0.0.1',
    };
    const to = {
      id: 'to-1',
      name: 'workload-live',
      masterIpAddress: '10.0.0.2',
    };
    const zones = opts.zones ?? {
      'z-from': { clusterId: 'from-1', zoneName: ZONE },
      'z-to': { clusterId: 'to-1', zoneName: ZONE },
    };
    const zoneRows = Object.entries(zones).map(([id, z]) => ({
      id,
      clusterId: z.clusterId,
      dnsZone: { zoneName: z.zoneName },
    }));

    const application: Record<string, unknown> = {
      id: 'app-1',
      name: 'App One',
      slug: 'app',
      clusterId: 'from-1',
      metadata: opts.ledger ? { rebuild: opts.ledger } : {},
    };
    const endpoints = opts.endpoints.map((e) => ({ ...e }));

    const service = Object.create(
      ClusterRebuildService.prototype,
    ) as ClusterRebuildService;
    const r = service as unknown as Record<string, unknown>;

    r.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    r.appRepo = {
      findOne: jest.fn(async () => application),
      update: jest.fn(async (_c: unknown, patch: Record<string, unknown>) => {
        Object.assign(application, patch);
      }),
    };
    r.endpointRepo = {
      find: jest.fn(async () => endpoints),
      update: jest.fn(
        async (c: { id: string }, patch: Record<string, unknown>) => {
          const row = endpoints.find((e) => e.id === c.id);
          if (row) Object.assign(row, patch);
        },
      ),
    };
    r.zoneAssignmentRepo = {
      find: jest.fn(async (q: { where: { clusterId: string } }) =>
        zoneRows.filter((z) => z.clusterId === q.where.clusterId),
      ),
      findOne: jest.fn(
        async (q: { where: { id: string } }) =>
          zoneRows.find((z) => z.id === q.where.id) ?? null,
      ),
    };
    // Computes. A mock answering by call order agrees with the defect.
    r.endpointMode = {
      generateFqdn: jest.fn(
        (
          mode: string,
          slug: string,
          cluster: { name: string; masterIpAddress: string },
          zone?: { dnsZone?: { zoneName: string } } | null,
        ) => {
          if (mode === 'ip') {
            return `${slug}.${cluster.masterIpAddress.replace(/\./g, '-')}.nip.io`;
          }
          if (!zone?.dnsZone) throw new Error('no zone');
          return `${slug}.${cluster.name}.${zone.dnsZone.zoneName}`;
        },
      ),
    };
    const released: string[] = [];
    const reconciled: string[] = [];
    r.endpointReconciliation = {
      releaseDnsRecord: jest.fn(async (id: string) => {
        released.push(id);
      }),
      reconcile: jest.fn(async (id: string) => {
        reconciled.push(id);
      }),
    };
    r.dataRestorer = {
      restoreInto: jest.fn(async () => []),
      forget: jest.fn(async () => undefined),
    };
    r.deploy = { deploy: jest.fn(async () => ({ id: 'op-1' })) };
    r.operationRepo = {
      findOne: jest.fn(async () => ({ status: 'COMPLETED' })),
    };
    r.catalogInstallRepo = { update: jest.fn(async () => undefined) };
    r.policyRepo = { update: jest.fn(async () => undefined) };
    r.dataSource = {
      transaction: jest.fn(
        async (cb: (m: Record<string, unknown>) => Promise<void>) =>
          cb({
            update: async (
              entity: { name: string },
              c: { id: string },
              patch: Record<string, unknown>,
            ) => {
              if (entity.name === 'AppEndpointEntity') {
                const row = endpoints.find((e) => e.id === c.id);
                if (row) Object.assign(row, patch);
                return;
              }
              if (entity.name === 'ApplicationEntity') {
                Object.assign(application, patch);
              }
            },
            createQueryBuilder: () => {
              const qb: Record<string, unknown> = {};
              for (const m of ['update', 'set', 'where']) {
                qb[m] = jest.fn(() => qb);
              }
              qb.execute = jest.fn(async () => undefined);
              return qb;
            },
          }),
      ),
    };

    const run = async () => {
      jest.useFakeTimers();
      const running = (
        service as unknown as {
          rebuildOne(
            u: string,
            id: string,
            f: unknown,
            t: unknown,
          ): Promise<Record<string, unknown>>;
        }
      ).rebuildOne('user-1', 'app-1', from, to);
      await jest.advanceTimersByTimeAsync(6_000);
      const result = await running;
      jest.useRealTimers();
      return result;
    };

    return { run, application, endpoints, released, reconciled, r };
  }

  const derived = (over: Record<string, unknown> = {}) => ({
    id: 'ep-1',
    applicationId: 'app-1',
    fqdn: `app.workload-lost.${ZONE}`,
    clusterId: 'from-1',
    clusterDnsZoneId: 'z-from',
    hostnameMode: 'domain',
    dnsRecordId: 'rec-1',
    dnsRecordValue: '10.0.0.1',
    ...over,
  });

  it('renames a name Flui generated, and says so', async () => {
    const h = harness({ endpoints: [derived()] });

    const result = await h.run();

    expect(h.endpoints[0].fqdn).toBe(`app.workload-live.${ZONE}`);
    expect(result.endpointMoved).toEqual([
      { from: `app.workload-lost.${ZONE}`, to: `app.workload-live.${ZONE}` },
    ]);
    expect(h.released).toEqual(['ep-1']);
    expect(h.reconciled).toEqual(['ep-1']);
  });

  it('classifies against the source, not the row it is about to overwrite', async () => {
    // The defect in the flesh: `repoint` writes the destination into
    // `clusterId`, so a classifier reading it back compared the destination's
    // own name against a name still holding the source's and called every
    // generated hostname a custom one.
    const h = harness({ endpoints: [derived()] });

    await h.run();

    const calls = (h.r.endpointMode as { generateFqdn: jest.Mock }).generateFqdn
      .mock.calls;
    expect(calls[0][2]).toEqual(expect.objectContaining({ id: 'from-1' }));
    expect(calls[0][3]).toEqual(expect.objectContaining({ id: 'z-from' }));
  });

  it('still renames when the row already names the destination', async () => {
    // A resumed run: `repoint` ran last time and moved both columns the
    // classification used to read. This is the case that failed live.
    const h = harness({
      ledger: { phase: 'deployed', to: 'to-1', at: 'yesterday' },
      endpoints: [derived({ clusterId: 'to-1', clusterDnsZoneId: 'z-to' })],
    });

    await h.run();

    expect(h.endpoints[0].fqdn).toBe(`app.workload-live.${ZONE}`);
  });

  it('renames from the ledger when the lost cluster took its zone with it', async () => {
    // `cluster_dns_zones` cascades on delete, so a resumed run can find no
    // trace of what the name was derived from. The decision was recorded when
    // it was still knowable.
    const h = harness({
      ledger: {
        phase: 'deployed',
        to: 'to-1',
        from: 'from-1',
        endpoints: {
          'ep-1': {
            from: `app.workload-lost.${ZONE}`,
            to: `app.workload-live.${ZONE}`,
          },
        },
      },
      zones: { 'z-to': { clusterId: 'to-1', zoneName: ZONE } },
      endpoints: [derived({ clusterId: 'to-1', clusterDnsZoneId: 'z-to' })],
    });

    await h.run();

    expect(h.endpoints[0].fqdn).toBe(`app.workload-live.${ZONE}`);
  });

  it('keeps a name the user chose, and unpins it from the dead address', async () => {
    // `reconcileDnsRecord` prefers a stored `dnsRecordValue` over the cluster's
    // own master, so leaving one holds a custom domain on the lost cluster's IP
    // — and the zone sweep then defends it as desired.
    const h = harness({
      endpoints: [derived({ fqdn: 'www.shop.example.com' })],
    });

    const result = await h.run();

    expect(h.endpoints[0].fqdn).toBe('www.shop.example.com');
    expect(h.endpoints[0].dnsRecordValue).toBeNull();
    expect(result.endpointMoved).toBeUndefined();
    expect(h.reconciled).toEqual(['ep-1']);
  });

  it('reports every name that moved, not the first', async () => {
    // Both are Flui's, derived differently: one under the zone, one on nip.io.
    const h = harness({
      endpoints: [
        derived(),
        derived({
          id: 'ep-2',
          fqdn: 'app.10-0-0-1.nip.io',
          hostnameMode: 'ip',
        }),
      ],
    });

    const result = await h.run();

    expect(result.endpointMoved).toHaveLength(2);
  });

  it('moves the zone assignment a skipped repoint left behind', async () => {
    // Its fallback address for the zone reconciler is the lost cluster's
    // master, which is the address the rename is trying to get away from.
    const h = harness({
      ledger: { phase: 'deployed', to: 'to-1', at: 'yesterday' },
      endpoints: [derived({ clusterId: 'to-1' })],
    });

    await h.run();

    expect(h.endpoints[0].clusterDnsZoneId).toBe('z-to');
    // Released while the row still named the zone that owns the record.
    const release = (
      h.r.endpointReconciliation as { releaseDnsRecord: jest.Mock }
    ).releaseDnsRecord.mock.invocationCallOrder[0];
    const write = (h.r.endpointRepo as { update: jest.Mock }).update.mock
      .invocationCallOrder[0];
    expect(release).toBeLessThan(write);
  });

  it('says the names were kept when the destination has no zone', async () => {
    const h = harness({
      zones: { 'z-from': { clusterId: 'from-1', zoneName: ZONE } },
      endpoints: [derived()],
    });

    const result = await h.run();

    expect(h.endpoints[0].fqdn).toBe(`app.workload-lost.${ZONE}`);
    expect((result.notes as string[]).join(' ')).toMatch(
      /no assignment for this zone/,
    );
  });
});
