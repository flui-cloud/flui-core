import chalk from 'chalk';

export type Paint = (text: string) => string;

const plain: Paint = (text) => text;

const TONE: Record<string, 'ok' | 'warn' | 'bad' | 'idle'> = {
  running: 'ok',
  healthy: 'ok',
  warning: 'warn',
  degraded: 'warn',
  error: 'bad',
  down: 'bad',
  stopped: 'idle',
};

export function toneOf(status: string | null | undefined): Paint {
  switch (TONE[status ?? '']) {
    case 'ok':
      return chalk.green;
    case 'warn':
      return chalk.yellow;
    case 'bad':
      return chalk.red;
    default:
      return chalk.dim;
  }
}

const LABEL: Record<string, string> = {
  running: 'Running',
  healthy: 'Healthy',
  warning: 'Warning',
  degraded: 'Degraded',
  error: 'Error',
  down: 'Down',
  stopped: 'Stopped',
};

export function statusLabel(status: string | null | undefined): string {
  return LABEL[status ?? ''] ?? 'Unknown';
}

export function memory(mi: number): string {
  if (mi < 1024) return `${Math.round(mi)} MB`;
  return `${(mi / 1024).toFixed(mi >= 10_240 ? 0 : 1)} GB`;
}

export function cpu(millicores: number): string {
  return millicores >= 1000
    ? `${(millicores / 1000).toFixed(1)} vCPU`
    : `${millicores}m`;
}

export function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : `${Math.round(value)}%`;
}

/** A use percentage, yellow from 75 and red from 90 like `flui now`. */
export function usePaint(value: number | null | undefined): Paint {
  if (value === null || value === undefined) return chalk.dim;
  if (value >= 90) return chalk.red;
  return value >= 75 ? chalk.yellow : plain;
}

export function rpsValue(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return value >= 10 ? `${Math.round(value)}` : value.toFixed(1);
}

export function rps(value: number | null | undefined): string {
  return value === null || value === undefined
    ? '—'
    : `${rpsValue(value)} req/s`;
}

export function overlayLabel(overlay: string): string {
  if (overlay === 'tunnel') return 'the Flui network';
  if (overlay === 'public-address') return 'its public address';
  return 'its address, Flui network off';
}

const CATEGORY: Record<string, string> = {
  database: 'Database',
  cache: 'Cache',
  storage: 'Storage',
  automation: 'Automation',
  media: 'Media',
  monitoring: 'Monitoring',
  web: 'Web app',
  business: 'Business app',
  infra: 'Infrastructure',
};

export function categoryLabel(category: string | null | undefined): string {
  return CATEGORY[category ?? ''] ?? 'App';
}

export const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? '' : 's'}`;

export function truncate(text: string, width: number): string {
  if (width <= 0) return '';
  if (text.length <= width) return text;
  return width === 1 ? '…' : `${text.slice(0, width - 1)}…`;
}

export interface Column {
  width: number;
  align?: 'right';
}

export type Cell = string | { text: string; paint?: Paint };

/** One table row: each cell cut and padded to its column, then painted, so colour never shifts a column. */
export function row(columns: Column[], cells: Cell[], gap = 2): string {
  return columns
    .map((column, i) => {
      const cell = cells[i] ?? '';
      const text = typeof cell === 'string' ? cell : cell.text;
      const paint = typeof cell === 'string' ? plain : (cell.paint ?? plain);
      const cut = truncate(text, column.width);
      const padded =
        column.align === 'right'
          ? cut.padStart(column.width)
          : cut.padEnd(column.width);
      return paint(padded);
    })
    .join(' '.repeat(gap))
    .trimEnd();
}

/** Label and value pairs, two to a line. */
export type Fact = [label: string, value: string, paint?: Paint];

export function facts(
  pairs: Fact[],
  labelWidth = 14,
  valueWidth = 22,
): string[] {
  const cell = ([label, value, paint = plain]: Fact) =>
    `${chalk.dim(label.padEnd(labelWidth))}${paint(truncate(value, valueWidth).padEnd(valueWidth))}`;
  const lines: string[] = [];
  for (let i = 0; i < pairs.length; i += 2) {
    const left = cell(pairs[i]);
    const right = pairs[i + 1] ? `  ${cell(pairs[i + 1])}` : '';
    lines.push(`${left}${right}`.trimEnd());
  }
  return lines;
}

export type ConnectionState = 'connecting' | 'live' | 'reconnecting';

export function connectionLabel(state: ConnectionState): string {
  if (state === 'live') return chalk.green('● live');
  return chalk.yellow(`○ ${state}`);
}
