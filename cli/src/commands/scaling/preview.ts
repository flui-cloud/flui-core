import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import type { ScalingPreviewDto } from 'src/modules/infrastructure/scaling/dto/scaling-preview.dto';
import type { ScalingGroupResponseDto } from 'src/modules/infrastructure/scaling/dto/scaling-response.dto';
import {
  ScalingClient,
  resolveGroup,
  scalingErrorLines,
} from '../../lib/scaling-client';
import {
  NO_PRICE,
  describeChosen,
  describePending,
  formatBounds,
  ladderRows,
} from '../../lib/scaling-view';

/**
 * What this group would do if a node were needed right now, spending nothing.
 *
 * `why` answers about a pass that already happened; this asks the same engine
 * the question now. The whole ladder is shown and every rung that loses says so
 * in its own words — including the one that reads like an outage and is a
 * setting: a shape that is available and affordable and refused by this group's
 * own rules.
 */
export default class ScalingPreview extends Command {
  static readonly description =
    'What a scaling group would do if a node were needed right now — the same engine the reconciler ' +
    'runs, on demand, buying nothing.\n' +
    'Every rung of the ladder is shown with the reason it lost. `refused-by-limit` is this group’s own ' +
    'rules and not the market, which from the outside looks exactly like an outage.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> general --cluster prod-eu',
    '<%= config.bin %> <%= command.id %> --output json',
  ];

  static readonly args = {
    group: Args.string({
      description:
        'Scaling group name or ID (default: the only group of the cluster)',
      required: false,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ScalingPreview);
    const spinner = ora('Asking what it would do...').start();
    // The preview route landed after the rest of the surface, so an API one
    // build behind must not be reported as an API without scaling at all.
    let absent: string | undefined;

    try {
      const client = ScalingClient.open();
      const { group } = await resolveGroup(client, flags.cluster, args.group);
      absent =
        'This installation’s API cannot preview a scaling group: it is running a build without that route. ' +
        'Ask what it last decided instead — `flui scaling why`.';
      const preview = await client.preview(group.id);
      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(preview, null, 2));
        return;
      }
      this.print(group, preview);
    } catch (error: unknown) {
      spinner.stop();
      console.log('');
      for (const line of scalingErrorLines(error, absent)) {
        console.log(chalk.red(`  ${line}`));
      }
      console.log('');
      this.exit(1);
    }
  }

  private print(
    group: ScalingGroupResponseDto,
    preview: ScalingPreviewDto,
  ): void {
    console.log('');
    console.log(
      `  ${chalk.cyan(chalk.bold(group.name))} ${chalk.dim(`on ${group.clusterName}`)}  ` +
        chalk.dim(`${formatBounds(group.bounds)} · ${group.provider}`),
    );
    console.log(chalk.dim('  Nothing is bought by asking this.'));
    console.log('');

    console.log(
      `  ${chalk.dim('waiting'.padEnd(9))}${describePending(preview)}`,
    );
    if (preview.opportunityHeldBecause) {
      console.log(
        `  ${chalk.dim('held'.padEnd(9))}${chalk.yellow(preview.opportunityHeldBecause)}`,
      );
    }
    console.log(`  ${chalk.dim('chosen'.padEnd(9))}${describeChosen(preview)}`);
    if (preview.asks) {
      console.log(
        `  ${chalk.dim('asks'.padEnd(9))}${chalk.yellow(preview.asks)}`,
      );
    }

    this.printLadder(preview);
    console.log('');
  }

  private printLadder(preview: ScalingPreviewDto): void {
    const rows = ladderRows(preview);
    if (!rows.length) {
      console.log('');
      console.log(
        chalk.dim(
          '  No ladder was walked: there was nothing to buy for, so no shape was weighed.',
        ),
      );
      return;
    }

    console.log('');
    console.log(
      chalk.dim(
        `    ${'#'.padEnd(3)} ${'SHAPE'.padEnd(12)} ${'REGION'.padEnd(10)} ${'PRICE'.padEnd(12)} ` +
          'OUTCOME           WHY',
      ),
    );
    for (const row of rows) {
      console.log(
        `    ${row.step.padEnd(3)} ${row.shape.padEnd(12)} ${row.region.padEnd(10)} ` +
          `${row.price.padEnd(12)} ${this.colourOutcome(row.outcome)} ${chalk.dim(row.reason)}`,
      );
      console.log(`    ${' '.repeat(3)} ${chalk.dim(row.describes)}`);
    }
    console.log('');
    console.log(
      chalk.dim(
        `  ${NO_PRICE} is no price at all, not a price of zero. ` +
          '`refused-by-limit` is this group’s own rules, not the market.',
      ),
    );
  }

  private colourOutcome(outcome: string): string {
    const cell = outcome.padEnd(17);
    if (outcome === 'would-buy') return chalk.green(cell);
    if (outcome === 'alert') return chalk.yellow(cell);
    return chalk.dim(cell);
  }
}
