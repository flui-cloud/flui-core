import type { PolicyTargets } from './policy-targets.util';
import { CronExpressionParser } from 'cron-parser';
import {
  Moment,
  describeCron,
  iso,
  nextDue,
  previousDue,
  toDate,
} from './backup-cron.util';
import { computeHealth, newestFirst } from './backup-health.util';

export {
  MISSED_SLACK_MS,
  describeCron,
  formatUtcMoment,
  nextDue,
  previousDue,
} from './backup-cron.util';
export { START_TOLERANCE_MS, computeHealth } from './backup-health.util';

export type BackupHealthState =
  | 'ok'
  | 'running'
  | 'failed'
  | 'missed'
  | 'paused'
  | 'never_run'
  | 'on_demand';

export type BackupRunTrigger =
  | 'scheduled'
  | 'manual'
  | 'platform_update'
  | (string & {});

export type BackupRunStored = 'present' | 'expired' | 'missing' | 'unknown';

export interface BackupRun {
  jobId: string;
  trigger: BackupRunTrigger;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationSeconds: number | null;
  sizeBytes: number | null;
  encrypted: boolean | null;
  expiresAt: string | null;
  stored: BackupRunStored;
  errorMessage: string | null;
}

export interface BackupSchedule {
  cron: string | null;
  description: string;
  timezone: 'UTC';
  nextRunAt: string | null;
  previousDueAt: string | null;
}

export interface BackupHealth {
  state: BackupHealthState;
  detail: string;
  lastSuccessAt: string | null;
}

export interface BackupPolicyActivity {
  policyId: string;
  policyName: string;
  engineClass: string;
  status: string;
  schedule: BackupSchedule;
  health: BackupHealth;
  lastRun: BackupRun | null;
  runs: BackupRun[];
  /** Only on a single policy's activity. */
  targets?: PolicyTargets;
}

type Bag = Record<string, unknown> | null;

export interface ActivityPolicy {
  id: string;
  name: string;
  engineClass: string;
  status: string;
  enabled?: boolean;
  cronSchedule?: string | null;
  nextRunAt?: Moment;
  createdAt: Moment;
  metadata?: Record<string, unknown> | null;
}

export interface ActivityJob {
  id: string;
  triggerType: string;
  triggerContext?: Bag;
  metadata?: Bag;
  status: string;
  startedAt?: Moment;
  finishedAt?: Moment;
  errorMessage?: string | null;
  createdAt: Moment;
}

export interface ActivityArtifact {
  sizeBytes?: string | number | null;
  expiresAt?: Moment;
  encryptionMode?: string | null;
  manifestSummary?: Bag;
  locations?: Array<{ state: string }> | null;
}

/** The scheduler ticks every minute; a legacy scheduled job lands inside this. */
const LEGACY_SCHEDULED_WINDOW_MS = 2 * 60 * 1000;

export const DEFAULT_ACTIVITY_LIMIT = 30;
export const MAX_ACTIVITY_LIMIT = 100;

const PRESENT = new Set(['available', 'verified']);
const LOST = new Set(['missing', 'failed']);

export function clampActivityLimit(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return DEFAULT_ACTIVITY_LIMIT;
  return Math.min(Math.floor(n), MAX_ACTIVITY_LIMIT);
}

/** Whether the scheduler would run this policy at all. */
function isScheduled(policy: ActivityPolicy): boolean {
  return (
    !!policy.cronSchedule?.trim() &&
    policy.enabled !== false &&
    policy.status === 'active'
  );
}

export function buildSchedule(
  policy: ActivityPolicy,
  now: Date,
): BackupSchedule {
  const cron = policy.cronSchedule?.trim() || null;
  const createdAt = toDate(policy.createdAt);
  const due = previousDue(cron, now);
  const stored = toDate(policy.nextRunAt);
  let nextRunAt: Date | null = null;
  if (isScheduled(policy)) {
    nextRunAt = stored && stored > now ? stored : nextDue(cron, now);
  }
  return {
    cron,
    description: describeCron(cron),
    timezone: 'UTC',
    nextRunAt: nextRunAt?.toISOString() ?? null,
    previousDueAt:
      due && (!createdAt || due >= createdAt) ? due.toISOString() : null,
  };
}

/**
 * Jobs created before the scheduler recorded its own trigger were all stored as
 * `on_demand`. One with no context, enqueued within the scheduler's tick of a
 * due time, was the schedule's.
 */
function looksScheduled(job: ActivityJob, cron: string | null): boolean {
  if (!cron) return false;
  if (Object.keys(job.triggerContext ?? {}).length > 0) return false;
  const created = toDate(job.createdAt);
  if (!created) return false;
  try {
    const due = CronExpressionParser.parse(cron, {
      currentDate: new Date(created.getTime() + 1),
      tz: 'UTC',
    })
      .prev()
      .toDate();
    return created.getTime() - due.getTime() <= LEGACY_SCHEDULED_WINDOW_MS;
  } catch {
    return false;
  }
}

export function runTrigger(
  job: ActivityJob,
  cron: string | null = null,
): BackupRunTrigger {
  if (job.triggerContext?.platformUpdate || job.metadata?.platformUpdate) {
    return 'platform_update';
  }
  if (job.triggerType === 'scheduled') return 'scheduled';
  if (job.triggerType === 'on_demand') {
    return looksScheduled(job, cron) ? 'scheduled' : 'manual';
  }
  return job.triggerType;
}

function artifactEncrypted(a: ActivityArtifact): boolean | null {
  const repository = a.manifestSummary?.repository as
    | { cipher?: unknown }
    | undefined;
  const cipher = repository?.cipher;
  if (typeof cipher === 'string' && cipher) {
    if (cipher === 'none') return false;
    if (cipher === 'unknown') return null;
    return true;
  }
  if (a.encryptionMode === 'operator') return true;
  if (a.encryptionMode === 'none') return false;
  return null;
}

function jobEncrypted(artifacts: ActivityArtifact[]): boolean | null {
  if (artifacts.length === 0) return null;
  const each = artifacts.map(artifactEncrypted);
  if (each.includes(false)) return false;
  if (each.every((e) => e === true)) return true;
  return null;
}

function artifactStored(a: ActivityArtifact, now: Date): BackupRunStored {
  const states = (a.locations ?? []).map((l) => l.state);
  const expiresAt = toDate(a.expiresAt);
  if (states.includes('expired') || (expiresAt && expiresAt <= now)) {
    return 'expired';
  }
  if (states.some((s) => PRESENT.has(s))) return 'present';
  if (states.some((s) => LOST.has(s))) return 'missing';
  return 'unknown';
}

function jobStored(artifacts: ActivityArtifact[], now: Date): BackupRunStored {
  if (artifacts.length === 0) return 'unknown';
  const each = artifacts.map((a) => artifactStored(a, now));
  if (each.every((s) => s === 'present')) return 'present';
  if (each.includes('expired')) return 'expired';
  if (each.includes('missing')) return 'missing';
  return 'unknown';
}

function jobSize(artifacts: ActivityArtifact[]): number | null {
  const sizes = artifacts
    .map((a) => (a.sizeBytes == null ? null : Number(a.sizeBytes)))
    .filter((n): n is number => n != null && Number.isFinite(n));
  return sizes.length ? sizes.reduce((sum, n) => sum + n, 0) : null;
}

function earliestExpiry(artifacts: ActivityArtifact[]): string | null {
  const dates = artifacts
    .map((a) => toDate(a.expiresAt))
    .filter((d): d is Date => !!d)
    .sort((x, y) => x.getTime() - y.getTime());
  return dates[0]?.toISOString() ?? null;
}

export function toBackupRun(
  job: ActivityJob,
  artifacts: ActivityArtifact[],
  now: Date,
  cron: string | null = null,
): BackupRun {
  const started = toDate(job.startedAt);
  const finished = toDate(job.finishedAt);
  return {
    jobId: job.id,
    trigger: runTrigger(job, cron),
    status: job.status,
    startedAt: iso(started),
    finishedAt: iso(finished),
    durationSeconds:
      started && finished
        ? Math.max(
            0,
            Math.round((finished.getTime() - started.getTime()) / 1000),
          )
        : null,
    sizeBytes: jobSize(artifacts),
    encrypted: jobEncrypted(artifacts),
    expiresAt: earliestExpiry(artifacts),
    stored: jobStored(artifacts, now),
    errorMessage: job.errorMessage ?? null,
  };
}

export function buildPolicyActivity(
  policy: ActivityPolicy,
  jobs: ActivityJob[],
  artifactsByJob: Map<string, ActivityArtifact[]>,
  now: Date,
  limit: number = DEFAULT_ACTIVITY_LIMIT,
): BackupPolicyActivity {
  const cron = policy.cronSchedule?.trim() || null;
  const ordered = newestFirst(jobs);
  const run = (j: ActivityJob) =>
    toBackupRun(j, artifactsByJob.get(j.id) ?? [], now, cron);
  return {
    policyId: policy.id,
    policyName: policy.name,
    engineClass: policy.engineClass,
    status: policy.status,
    schedule: buildSchedule(policy, now),
    health: computeHealth(policy, jobs, artifactsByJob, now),
    lastRun: ordered[0] ? run(ordered[0]) : null,
    runs: ordered.slice(0, limit).map(run),
  };
}
