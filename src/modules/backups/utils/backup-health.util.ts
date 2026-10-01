import { retiredForGoneCluster } from './policy-cluster.util';
import {
  formatUtcMoment,
  iso,
  nextDue,
  previousDue,
  toDate,
} from './backup-cron.util';
import type {
  ActivityArtifact,
  ActivityJob,
  ActivityPolicy,
  BackupHealth,
  BackupHealthState,
} from './backup-activity.util';

/** A job enqueued this long before its due time still counts as that run. */
export const START_TOLERANCE_MS = 5 * 60 * 1000;

const IN_PROGRESS = new Set(['pending', 'running', 'uploading', 'replicating']);
const FINISHED = new Set(['completed', 'partially_completed', 'failed']);

function isPaused(policy: ActivityPolicy): boolean {
  return policy.status === 'paused' || policy.enabled === false;
}

export function newestFirst(jobs: ActivityJob[]): ActivityJob[] {
  const t = (j: ActivityJob) => toDate(j.createdAt)?.getTime() ?? 0;
  return [...jobs].sort((a, b) => t(b) - t(a));
}

type Finding = [BackupHealthState, string];
type Verdict = Finding | null;

interface HealthFacts {
  policy: ActivityPolicy;
  ordered: ActivityJob[];
  artifactsByJob: Map<string, ActivityArtifact[]>;
  now: Date;
  cron: string | null;
  lastSuccessAt: string | null;
  at: (d: Date) => string;
}

function runningVerdict({ ordered, now, at }: HealthFacts): Verdict {
  const active = ordered.find((j) => IN_PROGRESS.has(j.status));
  if (!active) return null;
  const since = toDate(active.startedAt);
  if (since)
    return ['running', `A backup started at ${at(since)} is in progress.`];
  const queued = at(toDate(active.createdAt) ?? now);
  return ['running', `A backup queued at ${queued} has not started yet.`];
}

function failedVerdict({
  ordered,
  artifactsByJob,
  now,
  at,
}: HealthFacts): Verdict {
  const last = ordered.find((j) => FINISHED.has(j.status));
  if (!last) return null;
  const ended = at(
    toDate(last.finishedAt) ??
      toDate(last.startedAt) ??
      toDate(last.createdAt) ??
      now,
  );
  if (last.status === 'failed') {
    const reason = last.errorMessage?.trim();
    const why = reason ? `: ${reason}` : '.';
    return ['failed', `The run that ended at ${ended} failed${why}`];
  }
  const captured = (artifactsByJob.get(last.id) ?? []).length > 0;
  if (last.status === 'partially_completed' && !captured) {
    return [
      'failed',
      `The run that ended at ${ended} finished without capturing anything.`,
    ];
  }
  return null;
}

/** The previous due time, when it fell after the policy existed. */
function dueSinceCreation({ policy, cron, now }: HealthFacts): Date | null {
  const due = previousDue(cron, now);
  const createdAt = toDate(policy.createdAt);
  return due && (!createdAt || due >= createdAt) ? due : null;
}

function missedVerdict(facts: HealthFacts): Verdict {
  const due = dueSinceCreation(facts);
  if (!due) return null;
  const from = due.getTime() - START_TOLERANCE_MS;
  const started = facts.ordered.some((j) => {
    const t = toDate(j.startedAt) ?? toDate(j.createdAt);
    return !!t && t.getTime() >= from;
  });
  return started
    ? null
    : ['missed', `The run due at ${facts.at(due)} did not start.`];
}

function neverRunVerdict({ ordered, cron, now, at }: HealthFacts): Verdict {
  if (ordered.length > 0) return null;
  if (!cron) {
    return [
      'never_run',
      'No backup has been taken yet; this policy runs only when started.',
    ];
  }
  const next = nextDue(cron, now);
  return [
    'never_run',
    next
      ? `No backup has run yet; the first is due at ${at(next)}.`
      : 'No backup has run yet.',
  ];
}

function settledVerdict({ cron, lastSuccessAt, at }: HealthFacts): Finding {
  const success = toDate(lastSuccessAt);
  if (!cron) {
    return [
      'on_demand',
      success
        ? `Runs only when started; the last success was at ${at(success)}.`
        : 'Runs only when started; no run has succeeded yet.',
    ];
  }
  return [
    'ok',
    success
      ? `The last run succeeded at ${at(success)}.`
      : 'No run has completed yet.',
  ];
}

/**
 * Health judged from the policy, its jobs (any order) and their artifacts.
 * The first verdict that applies wins, in the order written here.
 */
export function computeHealth(
  policy: ActivityPolicy,
  jobs: ActivityJob[],
  artifactsByJob: Map<string, ActivityArtifact[]>,
  now: Date,
): BackupHealth {
  const ordered = newestFirst(jobs);
  const lastSuccess = ordered.find((j) => j.status === 'completed');
  const lastSuccessAt =
    iso(lastSuccess?.finishedAt) ?? iso(lastSuccess?.createdAt) ?? null;
  const facts: HealthFacts = {
    policy,
    ordered,
    artifactsByJob,
    now,
    cron: policy.cronSchedule?.trim() || null,
    lastSuccessAt,
    at: (d) => formatUtcMoment(d, now),
  };
  const paused: Verdict = isPaused(policy)
    ? [
        'paused',
        retiredForGoneCluster(policy)
          ? 'Paused because its cluster no longer exists. The backups it took stay restorable.'
          : 'The policy is paused: no scheduled backup runs until it is resumed.',
      ]
    : null;
  const [state, detail] =
    paused ??
    runningVerdict(facts) ??
    failedVerdict(facts) ??
    missedVerdict(facts) ??
    neverRunVerdict(facts) ??
    settledVerdict(facts);
  return { state, detail, lastSuccessAt };
}
