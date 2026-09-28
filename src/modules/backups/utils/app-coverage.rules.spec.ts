import { ApplicationKind } from '../../applications/enums/application-kind.enum';
import { ApplicationCategory } from '../../applications/enums/application-category.enum';
import { BackupScope } from '../enums/backup-scope.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupPolicyStatus } from '../enums/backup-policy-status.enum';
import {
  CoverageApp,
  CoveragePolicy,
  classifyApp,
  dataReasonsOf,
  judgePolicy,
  latestCaptureSize,
  policyCovers,
  protectPath,
  recencyDeadline,
} from './app-coverage.rules';

const NOW = new Date('2026-09-27T12:00:00Z');

const app = (over: Partial<CoverageApp> = {}): CoverageApp => ({
  id: 'app-1',
  clusterId: 'c1',
  namespace: 'user-ns',
  kind: ApplicationKind.APPLICATION,
  category: ApplicationCategory.USER,
  volumes: [],
  workloadKind: 'Deployment',
  ...over,
});

const policy = (over: Partial<CoveragePolicy> = {}): CoveragePolicy => ({
  id: 'p1',
  name: 'nightly',
  clusterId: 'c1',
  scope: BackupScope.CLUSTER_ALL,
  engineClass: BackupEngineClass.VOLUME,
  scopeSelector: {},
  includePvcs: true,
  cronSchedule: '0 3 * * *',
  enabled: true,
  status: BackupPolicyStatus.ACTIVE,
  createdAt: new Date('2026-09-01T00:00:00Z'),
  ...over,
});

const never = () => null;
const at = (iso: string) => () => new Date(iso);

describe('dataReasonsOf', () => {
  it('names each of the three existing signals and nothing else', () => {
    expect(dataReasonsOf(app())).toEqual([]);
    expect(dataReasonsOf(app({ kind: ApplicationKind.DATABASE }))).toEqual([
      'database',
    ]);
    expect(
      dataReasonsOf(app({ volumes: [{ name: 'data', mountPath: '/d' }] })),
    ).toEqual(['volume']);
    expect(dataReasonsOf(app({ workloadKind: 'StatefulSet' }))).toEqual([
      'stateful',
    ]);
  });
});

describe('policyCovers', () => {
  it('counts the whole cluster, the namespace and the id, only on the same cluster', () => {
    expect(policyCovers(policy(), app(), false)).toBe(true);
    expect(policyCovers(policy({ clusterId: 'c2' }), app(), false)).toBe(false);
    expect(
      policyCovers(
        policy({
          scope: BackupScope.NAMESPACES,
          scopeSelector: { namespaces: ['user-ns'] },
        }),
        app(),
        false,
      ),
    ).toBe(true);
    expect(
      policyCovers(
        policy({
          scope: BackupScope.NAMESPACES,
          scopeSelector: { namespaces: ['other'] },
        }),
        app(),
        false,
      ),
    ).toBe(false);
    expect(
      policyCovers(
        policy({
          scope: BackupScope.APPLICATIONS,
          scopeSelector: { applicationIds: ['app-1'] },
        }),
        app(),
        false,
      ),
    ).toBe(true);
  });

  it('reads an empty namespace list as the whole cluster, as the engine runs it', () => {
    expect(
      policyCovers(
        policy({ scope: BackupScope.NAMESPACES, scopeSelector: {} }),
        app(),
        false,
      ),
    ).toBe(true);
  });

  it('cannot tell for a label selector', () => {
    expect(
      policyCovers(
        policy({
          scope: BackupScope.LABEL_SELECTOR,
          scopeSelector: { labelSelector: 'app=web' },
        }),
        app(),
        false,
      ),
    ).toBeNull();
  });

  it('ignores paused, disabled and platform policies', () => {
    expect(policyCovers(policy({ enabled: false }), app(), false)).toBe(false);
    expect(
      policyCovers(policy({ status: BackupPolicyStatus.PAUSED }), app(), false),
    ).toBe(false);
    expect(
      policyCovers(
        policy({ engineClass: BackupEngineClass.PLATFORM }),
        app(),
        false,
      ),
    ).toBe(false);
  });

  it('does not count a policy without volumes for an app that holds data', () => {
    expect(policyCovers(policy({ includePvcs: false }), app(), true)).toBe(
      false,
    );
    expect(policyCovers(policy({ includePvcs: false }), app(), false)).toBe(
      true,
    );
  });

  it('lets a database or copy policy cover only the application it names', () => {
    const db = policy({
      engineClass: BackupEngineClass.DATABASE,
      scope: BackupScope.CLUSTER_ALL,
      scopeSelector: { applicationIds: ['other'] },
    });
    expect(policyCovers(db, app(), true)).toBe(false);
    expect(
      policyCovers(
        { ...db, scopeSelector: { applicationIds: ['app-1'] } },
        app(),
        true,
      ),
    ).toBe(true);
  });
});

describe('recencyDeadline', () => {
  it('is the second scheduled run after the last success', () => {
    expect(
      recencyDeadline(
        '0 3 * * *',
        new Date('2026-09-26T03:05:00Z'),
      )?.toISOString(),
    ).toBe('2026-09-28T03:00:00.000Z');
    expect(
      recencyDeadline(
        '0 * * * *',
        new Date('2026-09-27T10:00:30Z'),
      )?.toISOString(),
    ).toBe('2026-09-27T12:00:00.000Z');
  });

  it('gives no deadline for a schedule it cannot read', () => {
    expect(recencyDeadline('not a cron', NOW)).toBeNull();
  });
});

describe('judgePolicy', () => {
  it('is protected while the last success is within two runs', () => {
    const v = judgePolicy(policy(), new Date('2026-09-26T03:05:00Z'), NOW);
    expect(v).toMatchObject({ state: 'protected', reason: 'recent_backup' });
  });

  it('is stale once two runs pass without a newer success', () => {
    const v = judgePolicy(policy(), new Date('2026-09-24T03:05:00Z'), NOW);
    expect(v).toMatchObject({ state: 'unprotected', reason: 'stale' });
  });

  it('waits for the first runs of a new policy, then says it never succeeded', () => {
    expect(
      judgePolicy(
        policy({ createdAt: new Date('2026-09-27T08:00:00Z') }),
        null,
        NOW,
      ),
    ).toMatchObject({ state: 'pending', reason: 'awaiting_first_run' });
    expect(judgePolicy(policy(), null, NOW)).toMatchObject({
      state: 'unprotected',
      reason: 'never_succeeded',
    });
  });

  it('does not count a policy with no schedule as recent protection', () => {
    expect(
      judgePolicy(policy({ cronSchedule: null }), new Date(), NOW),
    ).toMatchObject({ state: 'unprotected', reason: 'no_schedule' });
  });

  it('marks a label-selector policy to verify', () => {
    expect(
      judgePolicy(policy({ scope: BackupScope.LABEL_SELECTOR }), null, NOW),
    ).toMatchObject({ state: 'to_verify', reason: 'label_selector' });
  });
});

describe('classifyApp — the alarm rule', () => {
  it('raises the alarm for a database with no policy', () => {
    const c = classifyApp(
      app({ kind: ApplicationKind.DATABASE }),
      [],
      never,
      NOW,
    );
    expect(c).toMatchObject({
      holdsData: true,
      state: 'unprotected',
      reason: 'no_policy',
      alarm: true,
      policy: null,
    });
  });

  it('shows coverage without an alarm for an app that holds no data', () => {
    const c = classifyApp(app(), [], never, NOW);
    expect(c).toMatchObject({
      holdsData: false,
      state: 'unprotected',
      alarm: false,
    });
  });

  it('is quiet for a stateful app a cluster-wide policy backed up last night', () => {
    const c = classifyApp(
      app({ workloadKind: 'StatefulSet' }),
      [policy()],
      at('2026-09-27T03:04:00Z'),
      NOW,
    );
    expect(c).toMatchObject({
      state: 'protected',
      alarm: false,
      coveringPolicies: 1,
    });
    expect(c.policy?.id).toBe('p1');
  });

  it('alarms when the only covering policy has gone stale', () => {
    const c = classifyApp(
      app({ volumes: [{}] }),
      [policy()],
      at('2026-09-20T03:04:00Z'),
      NOW,
    );
    expect(c).toMatchObject({
      state: 'unprotected',
      reason: 'stale',
      alarm: true,
    });
  });

  it('prefers the policy that protects over one that does not', () => {
    const c = classifyApp(
      app({ volumes: [{}] }),
      [
        policy({ id: 'old' }),
        policy({ id: 'fresh', cronSchedule: '0 * * * *' }),
      ],
      (id) =>
        id === 'fresh'
          ? new Date('2026-09-27T11:10:00Z')
          : new Date('2026-09-01T03:00:00Z'),
      NOW,
    );
    expect(c.policy?.id).toBe('fresh');
    expect(c.state).toBe('protected');
  });

  it('does not alarm while a label selector leaves it undecided', () => {
    const c = classifyApp(
      app({ kind: ApplicationKind.DATABASE }),
      [policy({ scope: BackupScope.LABEL_SELECTOR })],
      never,
      NOW,
    );
    expect(c).toMatchObject({ state: 'to_verify', alarm: false });
  });

  it('does not alarm for a platform component', () => {
    const c = classifyApp(
      app({
        category: ApplicationCategory.SYSTEM,
        workloadKind: 'StatefulSet',
      }),
      [],
      never,
      NOW,
    );
    expect(c).toMatchObject({
      holdsData: true,
      state: 'unprotected',
      alarm: false,
    });
  });
});

describe('protectPath', () => {
  it('opens the policy form on this app, with the database engine for a database', () => {
    expect(
      protectPath({
        clusterId: 'c1',
        applicationId: 'a1',
        kind: 'APPLICATION',
      }),
    ).toBe('/management/backup/policies/new?clusterId=c1&applicationId=a1');
    expect(
      protectPath({
        clusterId: 'c1',
        applicationId: 'db1',
        kind: ApplicationKind.DATABASE,
      }),
    ).toBe(
      '/management/backup/policies/new?clusterId=c1&applicationId=db1&engineClass=database',
    );
  });
});

describe('latestCaptureSize', () => {
  it('sums the artifacts of the newest run only', () => {
    expect(
      latestCaptureSize([
        { jobId: 'old', at: '2026-09-25T03:00:00Z', sizeBytes: '900' },
        { jobId: 'new', at: '2026-09-27T03:00:00Z', sizeBytes: '100' },
        { jobId: 'new', at: '2026-09-27T03:00:01Z', sizeBytes: 50 },
      ]),
    ).toBe(150);
  });

  it('says nothing rather than zero when no size was recorded', () => {
    expect(latestCaptureSize([])).toBeNull();
    expect(
      latestCaptureSize([
        { jobId: 'new', at: '2026-09-27T03:00:00Z', sizeBytes: null },
      ]),
    ).toBeNull();
  });
});
