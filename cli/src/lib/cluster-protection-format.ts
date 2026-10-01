import chalk from 'chalk';
import type { NeedsDecisionItem, ProtectedApp } from './backup-client';

const SKIP_REASON: Record<string, string> = {
  system: 'part of Flui, covered by the platform backup',
  no_data: 'holds no data',
};

/** One line per application: what it got, or why it got nothing. */
export function describeProtectedApp(app: ProtectedApp): string {
  const name = app.name ?? app.applicationId;
  switch (app.outcome) {
    case 'protected':
      return `  ${chalk.green('✓')} ${name}  ${chalk.dim(engineLabel(app.engine))}`;
    case 'already_protected':
      return `  ${chalk.green('✓')} ${name}  ${chalk.dim('already has a policy')}`;
    case 'waiting':
      return `  ${chalk.yellow('…')} ${name}  ${chalk.dim(app.reason ?? 'waiting')}`;
    case 'needs_decision':
      return `  ${chalk.yellow('?')} ${name}  ${chalk.dim('needs a decision, see below')}`;
    case 'failed':
      return `  ${chalk.red('✗')} ${name}  ${chalk.red(app.reason ?? 'failed')}`;
    default:
      return `  ${chalk.dim('–')} ${name}  ${chalk.dim(SKIP_REASON[app.reason ?? ''] ?? app.reason ?? 'skipped')}`;
  }
}

export function engineLabel(engine?: string): string {
  if (!engine) return 'protected';
  if (engine === 'kopia') return 'volume copies';
  if (engine.endsWith('-dump'))
    return `scheduled dumps (${engine.slice(0, -5)})`;
  return `continuous backup (${engine})`;
}

/** The volumes nobody has decided about, with the commands that decide. */
export function printNeedsDecision(items: NeedsDecisionItem[]): void {
  if (items.length === 0) return;
  console.log('');
  console.log(
    `  ${chalk.bold('Needs a decision')} ${chalk.dim('(no consistent backup while the application runs)')}`,
  );
  for (const item of items) {
    const what = item.volume ? `${item.slug} / ${item.volume}` : item.slug;
    console.log(`    ${chalk.yellow('?')} ${what}  ${chalk.dim(item.reason)}`);
  }
  const first = items[0];
  console.log('');
  console.log(
    chalk.dim(
      '   Copy it with the application stopped for the length of the copy:',
    ),
  );
  console.log(
    chalk.dim(
      `     flui backup enable volumes ${first.slug} --destination <destId> --pause`,
    ),
  );
  console.log(chalk.dim('   Or leave the volume out:'));
  console.log(
    chalk.dim(
      `     flui backup enable volumes ${first.slug} --destination <destId> --exclude ${first.volume ?? '<volume>'}`,
    ),
  );
  console.log('');
}
