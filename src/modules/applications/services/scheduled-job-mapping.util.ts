import { ApplicationEntity } from '../entities/application.entity';
import { ScheduledJobEntity } from '../entities/scheduled-job.entity';
import {
  ScheduledJobDto,
  ScheduledJobRunDto,
  ScheduledJobRunStatus,
} from '../dto/scheduled-job.dto';

export const SCHEDULED_JOB_LABEL = 'flui.cloud/scheduled-job';
const MAX_CRONJOB_NAME = 52; // Job names append `-<timestamp>` to this (63 cap).
/** Failed runs in a row after which a schedule is shown as failing. */
export const FAILING_AFTER = 3;

/**
 * A schedule failing run after run is shown as such: nothing else says it.
 */
export function withHealth(
  dto: ScheduledJobDto,
  jobs: Record<string, any>[],
): ScheduledJobDto {
  const mine = jobs
    .filter((j) => j?.metadata?.labels?.[SCHEDULED_JOB_LABEL] === dto.name)
    .map((j) => toRunDto(j))
    .filter((r) => r.status === 'Succeeded' || r.status === 'Failed')
    .sort((a, b) => runStartMs(b) - runStartMs(a));
  let consecutiveFailures = 0;
  for (const run of mine) {
    if (run.status !== 'Failed') break;
    consecutiveFailures++;
  }
  return {
    ...dto,
    lastRunStatus: mine[0]?.status ?? null,
    consecutiveFailures,
    failing: consecutiveFailures >= FAILING_AFTER,
  };
}

export function recordToDto(
  record: ScheduledJobEntity,
  cron: Record<string, any> | null | undefined,
): ScheduledJobDto {
  const status = cron?.status ?? {};
  return {
    name: record.name,
    resourceName: record.resourceName,
    schedule: record.schedule,
    command: record.command,
    timezone: record.timezone ?? undefined,
    concurrencyPolicy:
      record.concurrencyPolicy as ScheduledJobDto['concurrencyPolicy'],
    enabled: record.enabled,
    activeRuns: Array.isArray(status?.active) ? status.active.length : 0,
    lastScheduleTime: status?.lastScheduleTime ?? null,
    lastSuccessfulTime: status?.lastSuccessfulTime ?? null,
    createdAt: record.createdAt?.toISOString?.() ?? null,
    origin: record.origin,
    onCluster: !!cron,
  };
}

function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start++;
  while (end > start && value[end - 1] === '-') end--;
  return value.slice(start, end);
}

export function resourceName(app: ApplicationEntity, name: string): string {
  const sanitized = trimDashes(name.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
  return `${app.slug}-${sanitized}`.slice(0, MAX_CRONJOB_NAME);
}

export function toDto(cron: Record<string, any>): ScheduledJobDto {
  const meta = cron?.metadata ?? {};
  const spec = cron?.spec ?? {};
  const status = cron?.status ?? {};
  const container = spec?.jobTemplate?.spec?.template?.spec?.containers?.[0];
  const args: string[] = container?.args ?? [];

  return {
    name: meta?.labels?.[SCHEDULED_JOB_LABEL] ?? meta?.name ?? '',
    resourceName: meta?.name ?? '',
    schedule: spec?.schedule ?? '',
    command: args.at(-1) ?? '',
    timezone: spec?.timeZone ?? undefined,
    concurrencyPolicy: (spec?.concurrencyPolicy ??
      'Forbid') as ScheduledJobDto['concurrencyPolicy'],
    enabled: spec?.suspend !== true,
    activeRuns: Array.isArray(status?.active) ? status.active.length : 0,
    lastScheduleTime: status?.lastScheduleTime ?? null,
    lastSuccessfulTime: status?.lastSuccessfulTime ?? null,
    createdAt: meta?.creationTimestamp ?? null,
  };
}

export function toRunDto(job: Record<string, any>): ScheduledJobRunDto {
  const meta = job?.metadata ?? {};
  const status = job?.status ?? {};
  return {
    jobName: meta?.name ?? '',
    status: runStatus(status),
    manual: meta?.labels?.['flui.cloud/manual-run'] === 'true',
    startTime: status?.startTime ?? null,
    completionTime: status?.completionTime ?? null,
  };
}

export function runStatus(status: Record<string, any>): ScheduledJobRunStatus {
  if (status?.succeeded) return 'Succeeded';
  if (status?.failed) return 'Failed';
  if (status?.active) return 'Running';
  return 'Unknown';
}

export function runStartMs(run: ScheduledJobRunDto): number {
  return run.startTime ? Date.parse(run.startTime) : 0;
}
