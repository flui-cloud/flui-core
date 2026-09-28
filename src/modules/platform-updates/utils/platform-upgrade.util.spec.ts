import {
  PHASE_ORDER,
  approvalCovers,
  failureGuidance,
  isAcknowledged,
  k3sOrder,
  manifestOrder,
  nonImageReasons,
  phaseBudgetMs,
  upgradeDigest,
} from './platform-upgrade.util';
import {
  UpgradePlanPhase,
  WITHOUT_BACKUP_ACKNOWLEDGEMENT,
} from '../interfaces/platform-upgrade.interface';
import { PlatformReleaseEntry } from '../interfaces/release-manifest.interface';
import {
  K3S_CONTROLLER_WAIT_MS,
  K3S_STEP_BASE_MS,
  K3S_STEP_PER_NODE_MS,
} from './k3s-plans.util';

const phases = (planId = 'm1'): UpgradePlanPhase[] => [
  {
    key: 'backup',
    title: 'Backup',
    willRun: true,
    summary: 's',
    blockers: [],
    backup: { policyId: 'p1', policyName: 'platform' },
  },
  {
    key: 'manifests',
    title: 'Manifests',
    willRun: true,
    summary: 's',
    blockers: [],
    clusters: [
      {
        clusterId: 'c1',
        clusterName: 'control',
        clusterType: 'control',
        planId,
        upToDate: false,
        blockers: [],
      },
    ],
  },
];

const release = (over: Partial<PlatformReleaseEntry> = {}) =>
  ({
    version: '0.20.0',
    publishedAt: '',
    bootstrapRef: 'abc',
    images: {},
    notes: [],
    migrations: 0,
    requiresBootstrap: false,
    ...over,
  }) as PlatformReleaseEntry;

describe('platform upgrade plan id', () => {
  it('is stable for the same plan, whatever order the keys were built in', () => {
    const a = upgradeDigest({
      targetVersion: '0.20.0',
      bootstrapRef: 'abc',
      k3sVersion: 'v1.36.1+k3s1',
      phases: phases(),
      blockers: [],
    });
    const reordered = JSON.parse(
      JSON.stringify({
        blockers: [],
        phases: phases(),
        k3sVersion: 'v1.36.1+k3s1',
        bootstrapRef: 'abc',
        targetVersion: '0.20.0',
      }),
    );
    expect(upgradeDigest(reordered)).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('changes when any cluster plan underneath it changes', () => {
    const base = {
      targetVersion: '0.20.0',
      bootstrapRef: 'abc',
      k3sVersion: null,
      blockers: [],
    };
    expect(upgradeDigest({ ...base, phases: phases('m1') })).not.toBe(
      upgradeDigest({ ...base, phases: phases('m2') }),
    );
  });
});

describe('phase ordering', () => {
  const clusters = [
    { clusterType: 'workload' as const, clusterName: 'w1' },
    { clusterType: 'control' as const, clusterName: 'ctl' },
    { clusterType: 'workload' as const, clusterName: 'w2' },
  ];

  it('runs backup, manifests, images, K3s and verify, in that order', () => {
    expect(PHASE_ORDER).toEqual([
      'backup',
      'manifests',
      'images',
      'k3s',
      'verify',
    ]);
  });

  it('refreshes the control first, then the workload clusters', () => {
    expect(manifestOrder(clusters).map((c) => c.clusterName)).toEqual([
      'ctl',
      'w1',
      'w2',
    ]);
  });

  it('upgrades K3s on the workload clusters first and the control last', () => {
    expect(k3sOrder(clusters).map((c) => c.clusterName)).toEqual([
      'w1',
      'w2',
      'ctl',
    ]);
  });
});

describe('what the legacy image-only path may still apply', () => {
  it('lets a release that only moves images through', () => {
    expect(nonImageReasons(release(), ['v1.35.4+k3s1'])).toEqual([]);
    expect(
      nonImageReasons(release({ k3s: { version: 'v1.35.4+k3s1' } }), [
        'v1.35.4+k3s1',
        'v1.36.0+k3s1',
      ]),
    ).toEqual([]);
  });

  it('names the phases a release adds beyond images', () => {
    const reasons = nonImageReasons(
      release({
        k3s: { version: 'v1.36.1+k3s1' },
        manifestSets: ['control'],
      }),
      ['v1.35.4+k3s1'],
    );
    expect(reasons.join(' ')).toContain('K3s');
    expect(reasons.join(' ')).toContain('manifests');
  });

  it('compares K3s against every cluster, not the build of the API', () => {
    const target = release({ k3s: { version: 'v1.35.4+k3s1' } });
    expect(
      nonImageReasons(target, ['v1.35.4+k3s1', 'v1.34.6+k3s1']).join(' '),
    ).toContain('K3s');
    expect(nonImageReasons(target, []).join(' ')).toContain('K3s');
  });

  it('treats a release that changes the bootstrap as more than images', () => {
    expect(
      nonImageReasons(release({ requiresBootstrap: true }), ['v1.35.4+k3s1'])
        .length,
    ).toBeGreaterThan(0);
  });
});

describe('applying manifests only as they were previewed', () => {
  const approved = [
    { name: 'a.yaml', action: 'replace' as const, releaseSha: '1' },
    { name: 'b.yaml', action: 'add' as const, releaseSha: '2' },
  ];

  it('accepts a subset of the approved files, same content', () => {
    expect(
      approvalCovers(approved, [
        { name: 'b.yaml', action: 'add', releaseSha: '2' },
      ]),
    ).toBe(true);
  });

  it('refuses a file nobody previewed, or one whose content moved', () => {
    expect(
      approvalCovers(approved, [
        { name: 'c.yaml', action: 'add', releaseSha: '3' },
      ]),
    ).toBe(false);
    expect(
      approvalCovers(approved, [
        { name: 'a.yaml', action: 'replace', releaseSha: '9' },
      ]),
    ).toBe(false);
  });
});

describe('guidance when a phase fails', () => {
  it('points the images phase at a rollback', () => {
    expect(failureGuidance('images', { migrationsRan: false })).toMatch(
      /roll.*back.*Updates|reconcile-images/i,
    );
  });

  it('names the backup to restore once migrations ran', () => {
    expect(
      failureGuidance('k3s', { migrationsRan: true, backupJobId: 'job-7' }),
    ).toContain('job-7');
  });

  it('names the copy of the replaced manifests', () => {
    expect(
      failureGuidance('manifests', {
        migrationsRan: false,
        planId: 'abc123',
        clusterName: 'ctl',
      }),
    ).toContain('flui-refresh-backup/abc123');
  });

  it('never suggests downgrading K3s', () => {
    const text = failureGuidance('k3s', { migrationsRan: false });
    expect(text).toMatch(/never downgrade/i);
    expect(text).toMatch(/resume/i);
  });
});

describe('deadlines and acknowledgement', () => {
  it('gives every phase a finite budget, and K3s one that grows with nodes', () => {
    for (const phase of PHASE_ORDER) {
      expect(phaseBudgetMs(phase, {})).toBeGreaterThan(0);
    }
    expect(phaseBudgetMs('k3s', { steps: 2, nodes: 3 })).toBeGreaterThan(
      phaseBudgetMs('k3s', { steps: 1, nodes: 1 }),
    );
  });

  it('sums the K3s budget over every cluster, step and node the plan names', () => {
    const MIN = 60_000;
    const oneStep = (nodes: number) =>
      K3S_STEP_BASE_MS + K3S_STEP_PER_NODE_MS * nodes;
    expect(
      phaseBudgetMs('k3s', {
        k3sClusters: [
          { steps: 2, nodes: 5 },
          { steps: 1, nodes: 1 },
        ],
      }),
    ).toBe(2 * K3S_CONTROLLER_WAIT_MS + 2 * oneStep(5) + oneStep(1));
    expect(
      phaseBudgetMs('k3s', { k3sClusters: [{ steps: 3, nodes: 10 }] }),
    ).toBeGreaterThan(3 * 200 * MIN);
  });

  it('accepts only the sentence itself as the acknowledgement', () => {
    expect(isAcknowledged(WITHOUT_BACKUP_ACKNOWLEDGEMENT)).toBe(true);
    expect(isAcknowledged(`  ${WITHOUT_BACKUP_ACKNOWLEDGEMENT} `)).toBe(true);
    expect(isAcknowledged('yes')).toBe(false);
    expect(isAcknowledged(undefined)).toBe(false);
  });
});
