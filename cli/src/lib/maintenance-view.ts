import chalk from 'chalk';
import type { DeferredAction } from './services/cli-app.service';

export function printOpening(next: string | null): void {
  if (!next) return;
  const at = new Date(next);
  const now = Math.abs(at.getTime() - Date.now()) < 60_000;
  console.log(
    `  ${chalk.dim('next opening')}  ${now ? 'open now' : at.toLocaleString()}`,
  );
}

export function printDeferred(rows: DeferredAction[]): void {
  if (!rows.length) {
    console.log(chalk.dim('  Nothing is held for the window.'));
    return;
  }
  console.log('');
  for (const row of rows) {
    const when = new Date(row.runAt).toLocaleString();
    const state =
      row.status === 'pending'
        ? chalk.yellow(`waits for ${when}`)
        : chalk.dim(row.status);
    const askedBy = chalk.dim(`asked by ${row.requestedBy} · ${row.id}`);
    console.log(`  ${chalk.cyan('•')} ${row.says} ${state}  ${askedBy}`);
    if (row.outcome) console.log(`      ${chalk.dim(row.outcome)}`);
  }
}
