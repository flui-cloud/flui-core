import chalk from 'chalk';
import { VisitorStats } from './sandbox-client';

const REASONS: Record<string, string> = {
  closed: 'entrance closed',
  'limit-ip': 'per-address limit',
  'limit-cli': 'per-address limit (CLI)',
  'limit-global': 'per-minute limit',
  'limit-day': 'daily limit',
  challenge: 'browser check failed',
  invalid: 'invalid sign-in',
  'no-admission': 'no valid ticket',
  error: 'error',
};

export function visitorLines(stats: VisitorStats): string[] {
  const row = (label: string, value: string | number) =>
    `   ${label.padEnd(28)} ${value}`;
  const reasons = stats.last24h.refusedByReason
    .filter((r) => r.count > 0)
    .map((r) => `${REASONS[r.reason] ?? r.reason} ${r.count}`)
    .join(', ');
  return [
    row(
      'Entrance',
      stats.entranceOpen ? chalk.green('open') : chalk.yellow('closed'),
    ),
    row('Visitors now', stats.visitorsNow),
    row('Ready ahead of time', `${stats.poolReady} of ${stats.poolMin}`),
    row('Came in, last 24 h', stats.last24h.created),
    row(
      'Turned away, last 24 h',
      reasons
        ? `${stats.last24h.refused} ${chalk.dim(`(${reasons})`)}`
        : stats.last24h.refused,
    ),
    row('Became accounts', stats.upgraded),
    row('Added to accounts', stats.merged),
  ];
}
