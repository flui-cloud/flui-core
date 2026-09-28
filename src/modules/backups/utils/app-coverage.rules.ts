import { CronExpressionParser } from 'cron-parser';
import { ApplicationKind } from '../../applications/enums/application-kind.enum';
import { ApplicationCategory } from '../../applications/enums/application-category.enum';
import { BackupScope } from '../enums/backup-scope.enum';
import { BackupEngineClass } from '../enums/backup-engine-class.enum';
import { BackupPolicyStatus } from '../enums/backup-policy-status.enum';

export type DataReason = 'database' | 'volume' | 'stateful';

export type AppCoverageState =
  | 'protected'
  | 'pending'
  | 'to_verify'
  | 'unprotected';

export type AppCoverageReason =
  | 'recent_backup'
  | 'awaiting_first_run'
  | 'label_selector'
  | 'stale'
  | 'never_succeeded'
  | 'left_out'
  | 'no_schedule'
  | 'no_policy';

export interface CoverageApp {
  id: string;
  clusterId: string;
  namespace: string;
  kind: ApplicationKind | string;
  category: ApplicationCategory | string;
  volumes?: unknown[] | null;
  workloadKind?: string | null;
}

export interface CoveragePolicy {
  id: string;
  name: string;
  clusterId: string;
  scope: BackupScope;
  engineClass: BackupEngineClass;
  scopeSelector?: {
    namespaces?: string[];
    applicationIds?: string[];
    labelSelector?: string;
  } | null;
  includePvcs?: boolean;
  cronSchedule?: string | null;
  retentionDays?: number | null;
  nextRunAt?: Date | null;
  enabled: boolean;
  status: BackupPolicyStatus | string;
  createdAt: Date;
}

export interface PolicyVerdict {
  policy: CoveragePolicy;
  state: AppCoverageState;
  reason: AppCoverageReason;
  lastSuccessAt: Date | null;
  /** When the policy stops counting as protection unless another backup succeeds. */
  deadline: Date | null;
}

export interface AppCoverage {
  holdsData: boolean;
  dataReasons: DataReason[];
  state: AppCoverageState;
  reason: AppCoverageReason;
  /** The policy behind the state, when one covers the application. */
  policy: CoveragePolicy | null;
  lastSuccessAt: Date | null;
  deadline: Date | null;
  coveringPolicies: number;
  alarm: boolean;
}

/** An application holds data when it is a database, declares a persistent volume, or runs as a stateful workload. */
export function dataReasonsOf(app: CoverageApp): DataReason[] {
  const reasons: DataReason[] = [];
  if (app.kind === ApplicationKind.DATABASE) reasons.push('database');
  if ((app.volumes?.length ?? 0) > 0) reasons.push('volume');
  if (app.workloadKind === 'StatefulSet') reasons.push('stateful');
  return reasons;
}

/**
 * Whether a policy reaches this application, as its engine will run it.
 *
 * `null` for a label-selector policy: the API does not see the labels on the
 * cluster, so it cannot tell.
 */
export function policyCovers(
  policy: CoveragePolicy,
  app: CoverageApp,
  holdsData: boolean,
): boolean | null {
  if (policy.clusterId !== app.clusterId) return false;
  if (!policy.enabled || policy.status === BackupPolicyStatus.PAUSED) {
    return false;
  }
  if (policy.engineClass === BackupEngineClass.PLATFORM) return false;

  const selector = policy.scopeSelector ?? {};
  if (
    policy.engineClass === BackupEngineClass.DATABASE ||
    policy.engineClass === BackupEngineClass.VOLUME_COPY
  ) {
    return (selector.applicationIds ?? []).includes(app.id);
  }

  if (holdsData && policy.includePvcs === false) return false;
  switch (policy.scope) {
    case BackupScope.CLUSTER_ALL:
      return true;
    case BackupScope.NAMESPACES: {
      const namespaces = selector.namespaces ?? [];
      return namespaces.length === 0 || namespaces.includes(app.namespace);
    }
    case BackupScope.APPLICATIONS:
      return (selector.applicationIds ?? []).includes(app.id);
    case BackupScope.LABEL_SELECTOR:
      return null;
    default:
      return false;
  }
}

/**
 * The second scheduled run after `from`: a backup counts as recent until two
 * runs of its schedule have passed without a newer success.
 */
export function recencyDeadline(cron: string, from: Date): Date | null {
  try {
    const runs = CronExpressionParser.parse(cron, {
      currentDate: from,
      tz: 'UTC',
    });
    runs.next();
    return runs.next().toDate();
  } catch {
    return null;
  }
}

export function judgePolicy(
  policy: CoveragePolicy,
  lastSuccessAt: Date | null,
  now: Date,
  leftOutByLastRun = false,
): PolicyVerdict {
  const base = { policy, lastSuccessAt };
  if (leftOutByLastRun) {
    return {
      ...base,
      state: 'unprotected',
      reason: 'left_out',
      deadline: null,
    };
  }
  if (policy.scope === BackupScope.LABEL_SELECTOR) {
    return {
      ...base,
      state: 'to_verify',
      reason: 'label_selector',
      deadline: null,
    };
  }
  const deadline = policy.cronSchedule
    ? recencyDeadline(policy.cronSchedule, lastSuccessAt ?? policy.createdAt)
    : null;
  if (!deadline) {
    return {
      ...base,
      state: 'unprotected',
      reason: 'no_schedule',
      deadline: null,
    };
  }
  const inTime = now.getTime() <= deadline.getTime();
  if (lastSuccessAt) {
    return inTime
      ? { ...base, state: 'protected', reason: 'recent_backup', deadline }
      : { ...base, state: 'unprotected', reason: 'stale', deadline };
  }
  return inTime
    ? { ...base, state: 'pending', reason: 'awaiting_first_run', deadline }
    : { ...base, state: 'unprotected', reason: 'never_succeeded', deadline };
}

const REASON_RANK: Record<AppCoverageReason, number> = {
  recent_backup: 0,
  awaiting_first_run: 1,
  label_selector: 2,
  stale: 3,
  never_succeeded: 4,
  left_out: 5,
  no_schedule: 6,
  no_policy: 7,
};

function better(a: PolicyVerdict, b: PolicyVerdict): PolicyVerdict {
  const rank = REASON_RANK[a.reason] - REASON_RANK[b.reason];
  if (rank !== 0) return rank < 0 ? a : b;
  const at = a.lastSuccessAt?.getTime() ?? 0;
  const bt = b.lastSuccessAt?.getTime() ?? 0;
  return at >= bt ? a : b;
}

/**
 * The one rule behind the home alarm and the backup column: an application
 * is protected when a policy covering it has succeeded recently. The alarm is
 * raised only for a user application that holds data and is not protected, and
 * not while a new policy is still inside its first two runs.
 */
export function classifyApp(
  app: CoverageApp,
  policies: CoveragePolicy[],
  lastSuccess: (policyId: string, applicationId: string) => Date | null,
  now: Date,
  leftOutByLastRun: (policyId: string) => boolean = () => false,
): AppCoverage {
  const dataReasons = dataReasonsOf(app);
  const holdsData = dataReasons.length > 0;
  const verdicts = policies
    .filter((p) => policyCovers(p, app, holdsData) !== false)
    .map((p) =>
      judgePolicy(p, lastSuccess(p.id, app.id), now, leftOutByLastRun(p.id)),
    );

  const best = verdicts.reduce<PolicyVerdict | null>(
    (acc, v) => (acc ? better(acc, v) : v),
    null,
  );
  const state: AppCoverageState = best?.state ?? 'unprotected';
  return {
    holdsData,
    dataReasons,
    state,
    reason: best?.reason ?? 'no_policy',
    policy: best?.policy ?? null,
    lastSuccessAt: best?.lastSuccessAt ?? null,
    deadline: best?.deadline ?? null,
    coveringPolicies: verdicts.length,
    alarm:
      holdsData &&
      app.category !== ApplicationCategory.SYSTEM &&
      state === 'unprotected',
  };
}

/**
 * The policy form, filled in for this app. A database gets the database
 * engine: the cluster-wide volume engine is the one that leaves its data
 * directory out.
 */
export function protectPath(row: {
  clusterId: string;
  applicationId: string;
  kind?: string;
}): string {
  const query = new URLSearchParams({
    clusterId: row.clusterId,
    applicationId: row.applicationId,
  });
  if (row.kind === ApplicationKind.DATABASE)
    query.set('engineClass', 'database');
  return `/management/backup/policies/new?${query.toString()}`;
}

export interface CaptureArtifact {
  jobId: string;
  at: Date | string;
  sizeBytes: string | number | null;
}

/**
 * The size of the newest backup of one application: the artifacts its newest
 * run wrote for it, summed. Null when that run recorded no size.
 */
export function latestCaptureSize(artifacts: CaptureArtifact[]): number | null {
  if (artifacts.length === 0) return null;
  const time = (a: CaptureArtifact) => new Date(a.at).getTime();
  const newest = artifacts.reduce(
    (acc, a) => (time(a) > time(acc) ? a : acc),
    artifacts[0],
  );
  const sizes = artifacts
    .filter((a) => a.jobId === newest.jobId && a.sizeBytes != null)
    .map((a) => Number(a.sizeBytes))
    .filter((n) => Number.isFinite(n));
  return sizes.length ? sizes.reduce((sum, n) => sum + n, 0) : null;
}
