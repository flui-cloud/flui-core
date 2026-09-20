jest.mock('@kubernetes/client-node', () => ({ CoreV1Api: 'CoreV1Api' }));

import * as yaml from 'js-yaml';

import {
  NodeStorageQuotaService,
  projectIdFor,
} from './node-storage-quota.service';

const build = () =>
  new NodeStorageQuotaService(
    {} as never,
    {} as never,
    {} as never,
  ) as never as {
    parse: (
      logs: string,
      node: string,
      planned: Array<{ namespace: string; bytes: number; projectId: number }>,
    ) => {
      node: string;
      supported: boolean;
      reason?: string;
      tenancies: Array<Record<string, number | string>>;
    };
    plan: (
      limits: Array<{ namespace: string; bytes: number }>,
    ) => Array<{ namespace: string; projectId: number }>;
    buildScript: (
      planned: Array<{ namespace: string; bytes: number; projectId: number }>,
    ) => string;
    buildJobManifest: (
      jobName: string,
      node: string,
      planned: Array<{ namespace: string; bytes: number; projectId: number }>,
    ) => string;
  };

describe('the project id a tenancy gets', () => {
  /**
   * The id is written into the filesystem, so it has to survive this service
   * forgetting everything. An id that drifted would strand the directories
   * already tagged with the old one and quietly double what a tenancy may use.
   */
  it('is the same every time for the same tenancy', () => {
    expect(projectIdFor('user-guest-0873b86b')).toBe(
      projectIdFor('user-guest-0873b86b'),
    );
  });

  it('differs between tenancies', () => {
    expect(projectIdFor('user-guest-a')).not.toBe(projectIdFor('user-guest-b'));
  });

  // 0 means "no project", which every untagged file already carries, and low
  // ids belong to the system.
  it('never lands on a system id', () => {
    for (const ns of ['a', 'user-demo', 'user-guest-ffffffff', '']) {
      expect(projectIdFor(ns)).toBeGreaterThanOrEqual(1000);
      expect(projectIdFor(ns)).toBeLessThan(0x7fffffff);
    }
  });
});

describe('planning what to cap', () => {
  it('gives each tenancy its own project', () => {
    const planned = build().plan([
      { namespace: 'user-guest-1', bytes: 100 },
      { namespace: 'user-guest-2', bytes: 200 },
    ]);

    expect(planned).toHaveLength(2);
    expect(planned[0].projectId).not.toBe(planned[1].projectId);
  });

  /**
   * The same tenancy named twice is not a collision — it is one tenancy — so
   * both entries keep the same project and nothing is dropped. The collision
   * this guards against is two *different* names hashing alike, which cannot
   * be produced here without forging a hash; what is pinned instead is that
   * sameness of name never produces two ceilings.
   */
  it('treats the same tenancy twice as one project, not two ceilings', () => {
    const planned = build().plan([
      { namespace: 'user-guest-1', bytes: 100 },
      { namespace: 'user-guest-1', bytes: 200 },
    ]);

    expect(new Set(planned.map((p) => p.projectId)).size).toBe(1);
  });
});

describe('reading back what the kernel believes', () => {
  const planned = [
    { namespace: 'user-guest-1', bytes: 20971520, projectId: 1234 },
  ];

  /**
   * Taken from a real run of `xfs_quota report -p -N -b`: the id carries a
   * `#`, and the numbers are kilobytes.
   */
  it('turns a report line into used and allowed bytes', () => {
    const logs = [
      'REPORT #0                  0          0          0     00 [--------]',
      'REPORT #1234            7168          0      20480     00 [--------]',
    ].join('\n');

    const result = build().parse(logs, 'master-1', planned);

    expect(result.supported).toBe(true);
    expect(result.tenancies).toEqual([
      {
        namespace: 'user-guest-1',
        projectId: 1234,
        usedBytes: 7168 * 1024,
        limitBytes: 20480 * 1024,
      },
    ]);
  });

  /**
   * The safe path, and the one every cluster takes until it is rebuilt with a
   * quota-capable filesystem: say so plainly rather than half-applying.
   */
  it('reports a node without quota support instead of pretending', () => {
    const result = build().parse(
      'UNSUPPORTED no project quota on /var/lib/flui/local',
      'master-1',
      planned,
    );

    expect(result.supported).toBe(false);
    expect(result.reason).toContain('no project quota');
    expect(result.tenancies).toEqual([]);
  });

  it('ignores projects it did not ask about', () => {
    const logs = 'REPORT #9999            100          0      200     00 [---]';

    expect(build().parse(logs, 'n1', planned).tenancies).toEqual([]);
  });
});

describe('the script that runs privileged on every node', () => {
  const script = () =>
    build().buildScript([
      { namespace: 'user-guest-1', bytes: 12884901888, projectId: 1234 },
    ]);

  // Verified against xfs_quota: a bare number in `bhard=` is bytes, so the
  // ceiling must be passed in bytes and not converted on the way out.
  it('passes the ceiling in bytes', () => {
    expect(script()).toContain('user-guest-1:1234:12884901888');
  });

  it('does nothing at all where the filesystem has no project quota', () => {
    expect(script()).toContain('prjquota');
    expect(script()).toContain('UNSUPPORTED');
  });

  it('never writes outside the local storage root', () => {
    expect(script()).not.toMatch(/rm -rf|mkfs|>\s*\/etc/);
  });
});

describe('the manifest that carries the script', () => {
  const planned = [
    { namespace: 'user-guest-1', bytes: 12884901888, projectId: 1234 },
  ];

  /**
   * The first shape of this joined every line of the script with `;`, which
   * turns `for … do` into `do;` — a syntax error sh refuses outright. The job
   * reported it only as "failed", and the pod carrying the message was already
   * deleted, so the cause took a live run to find. These two pin the shape.
   */
  it('keeps the script as real lines, not a semicolon soup', () => {
    const doc = yaml.load(
      build().buildJobManifest('j1', 'node-1', planned),
    ) as Record<string, any>;
    const script: string = doc.spec.template.spec.containers[0].args[0];

    expect(script.split('\n').length).toBeGreaterThan(5);
    expect(script).not.toMatch(/\bdo;/);
    expect(script).not.toMatch(/\bthen;/);
    expect(script).not.toMatch(/\bdone;\s*\S/);
  });

  /**
   * Found on a real workload cluster: the probe was placed in `flui-system`,
   * which belongs to the control plane and exists nowhere else, so Kubernetes
   * refused it and every node reported as though its storage could not enforce
   * a quota — a product-wide "no" produced by a namespace name.
   */
  it('runs where flui-local exists, not in the control plane’s namespace', () => {
    const doc = yaml.load(
      build().buildJobManifest('j1', 'node-1', planned),
    ) as Record<string, any>;

    expect(doc.metadata.namespace).toBe('flui-local-storage');
    expect(doc.metadata.namespace).not.toBe('flui-system');
  });

  /**
   * Measured on a real cluster: from inside a pod, `/var/lib/flui/local` is a
   * bind mount and `findmnt` shows nothing about the `prjquota` option that
   * decides everything — so a node enforcing quotas perfectly well reported
   * that it could not. The probe therefore enters pid 1's mount namespace and
   * needs no volumes of its own: it reads the host exactly as an operator
   * would over SSH.
   */
  it('looks at the host, not at the container it runs in', () => {
    const doc = yaml.load(
      build().buildJobManifest('j1', 'node-1', planned),
    ) as Record<string, any>;

    const spec = doc.spec.template.spec;
    expect(doc.kind).toBe('Job');
    expect(spec.nodeSelector['kubernetes.io/hostname']).toBe('node-1');
    expect(spec.hostPID).toBe(true);
    expect(spec.volumes).toBeUndefined();
    expect(spec.containers[0].args[0]).toContain('nsenter -t 1 -m');
  });
});
