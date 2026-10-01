import chalk from 'chalk';
import {
  BackupHealthState,
  BackupPolicyActivity,
  BackupRun,
} from './backup-client';
import { formatBytes } from './format-bytes';

const HEALTH_LABEL: Record<BackupHealthState, string> = {
  ok: chalk.green('ok'),
  running: chalk.cyan('running'),
  failed: chalk.red('failed'),
  missed: chalk.red('missed'),
  paused: chalk.yellow('paused'),
  never_run: chalk.yellow('never run'),
  on_demand: chalk.dim('on demand'),
};

export function healthLabel(state: string): string {
  return HEALTH_LABEL[state as BackupHealthState] ?? state;
}

export function utcMoment(value: string | null): string {
  if (!value) return '-';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function duration(seconds: number | null): string {
  if (seconds == null) return '-';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m ${seconds % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

type Paint = (text: string) => string;
const plain: Paint = (t) => t;

function encrypted(value: boolean | null): [string, Paint] {
  if (value === true) return ['yes', chalk.green];
  if (value === false) return ['no', chalk.yellow];
  return ['?', chalk.dim];
}

function statusPaint(value: string): Paint {
  if (value === 'completed') return chalk.green;
  if (value === 'failed') return chalk.red;
  return chalk.yellow;
}

function storedPaint(value: BackupRun['stored']): Paint {
  if (value === 'present') return chalk.green;
  if (value === 'unknown') return chalk.dim;
  return chalk.yellow;
}

export function scheduleText(a: BackupPolicyActivity): string {
  const cron = a.schedule.cron ? chalk.dim(` (${a.schedule.cron})`) : '';
  return `${a.schedule.description}${cron}`;
}

export function healthLine(a: BackupPolicyActivity): string {
  return `${healthLabel(a.health.state)} ${chalk.dim('-')} ${a.health.detail}`;
}

const WIDTHS = [21, 16, 20, 9, 11, 4, 0];

function row(cells: Array<[string, Paint]>): string {
  return cells
    .map(([text, paint], i) => paint(WIDTHS[i] ? text.padEnd(WIDTHS[i]) : text))
    .join(' ')
    .trimEnd();
}

export function runLines(runs: BackupRun[]): string[] {
  if (runs.length === 0) return [chalk.dim('no runs yet')];
  const header = row(
    ['STARTED', 'TRIGGER', 'STATUS', 'DURATION', 'SIZE', 'ENC', 'STORED'].map(
      (h): [string, Paint] => [h, chalk.dim],
    ),
  );
  const lines = runs.map((r) => {
    const line = row([
      [utcMoment(r.startedAt ?? r.finishedAt), plain],
      [r.trigger.replace('_', ' '), plain],
      [r.status, statusPaint(r.status)],
      [duration(r.durationSeconds), plain],
      [r.sizeBytes == null ? '-' : formatBytes(r.sizeBytes), plain],
      encrypted(r.encrypted),
      [r.stored, storedPaint(r.stored)],
    ]);
    if (!r.errorMessage) return line;
    const error = `  ${r.errorMessage}`;
    return `${line}\n${chalk.red(error)}`;
  });
  return [header, ...lines];
}
