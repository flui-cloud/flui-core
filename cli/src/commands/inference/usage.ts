import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { InferenceUsageClient } from '../../lib/inference-usage-client';
import { printContextBanner } from '../../lib/context-banner';

/**
 * Rough money, and said to be rough.
 *
 * Per-million-token prices differ by model and change without warning, so a
 * figure computed from a table baked in here would be wrong within a month and
 * would still look authoritative. `--price` takes the number from whoever is
 * reading the bill; without it the report says tokens and nothing else.
 */
function money(tokens: number, perMillion?: number): string {
  if (!perMillion) return '';
  const cost = (tokens / 1_000_000) * perMillion;
  // Two decimals turn a demo's whole week into "0.00", which reads as free and
  // is the one thing this number exists to disprove.
  const shown = cost >= 1 ? cost.toFixed(2) : cost.toFixed(4);
  return chalk.dim(`  ≈ ${shown}`);
}

function thousands(n: number): string {
  return n.toLocaleString('en-US');
}

export default class InferenceUsage extends Command {
  static readonly description =
    'What the assistant and the console copilots have spent, by model and by person';
  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --days 1',
    '<%= config.bin %> <%= command.id %> --days 0 --price 0.20',
  ];
  static readonly flags = {
    days: Flags.integer({
      description: 'Window to report on. 0 means everything.',
      default: 7,
    }),
    price: Flags.string({
      description:
        'Your price per million tokens, to turn the totals into money. Model prices differ, so this is your number, not a table baked into Flui.',
    }),
    json: Flags.boolean({ default: false }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(InferenceUsage);
    const report = await InferenceUsageClient.fromConfig().report(flags.days);

    if (flags.json) {
      this.log(JSON.stringify(report, null, 2));
      return;
    }

    printContextBanner();
    const perMillion = flags.price ? Number(flags.price) : undefined;
    const window = report.since
      ? `since ${new Date(report.since).toLocaleString()}`
      : 'all time';

    this.log('');
    this.log(`   ${chalk.bold('Inference usage')}  ${chalk.dim(window)}`);

    if (report.byModel.length === 0) {
      this.log('');
      this.log(chalk.dim('   Nothing spent in this window.'));
      this.log('');
      return;
    }

    const total = report.byModel.reduce(
      (n, m) => n + m.promptTokens + m.completionTokens,
      0,
    );
    this.log('');
    this.log(`   ${chalk.bold('By model')}`);
    for (const m of report.byModel) {
      const tokens = m.promptTokens + m.completionTokens;
      const guessed = m.estimated
        ? chalk.dim(`  (${m.estimated} counted from the text)`)
        : '';
      this.log(
        `     ${m.model.padEnd(38)} ${String(m.calls).padStart(5)} calls  ${thousands(
          tokens,
        ).padStart(11)} tokens${money(tokens, perMillion)}${guessed}`,
      );
    }

    this.log('');
    this.log(`   ${chalk.bold('Who spent it')}`);
    for (const p of report.byPerson) {
      const who = p.userId ? p.userId.slice(0, 8) : 'the platform';
      const kind = p.guest ? chalk.cyan('guest') : chalk.dim('member');
      this.log(
        `     ${who.padEnd(14)} ${kind.padEnd(16)} ${String(p.calls).padStart(
          5,
        )} calls  ${thousands(p.tokens).padStart(11)} tokens${money(
          p.tokens,
          perMillion,
        )}`,
      );
    }

    this.log('');
    this.log(
      `   ${chalk.bold('Total')}  ${thousands(total)} tokens${money(total, perMillion)}`,
    );
    if (!perMillion) {
      this.log(
        chalk.dim('   Pass --price <per million tokens> to see this in money.'),
      );
    }
    this.log('');
  }
}
