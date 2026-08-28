import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import type {
  ClusterScalingDecisionDto,
  ScalingDecisionResponseDto,
  ScalingGroupResponseDto,
} from 'src/modules/infrastructure/scaling/dto/scaling-response.dto';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import {
  ScalingClient,
  resolveGroup,
  scalingErrorLines,
} from '../../lib/scaling-client';
import {
  NO_PRICE,
  type DecisionView,
  describeClusterSilence,
  describeDecision,
  describeSilence,
  formatBounds,
  outcomeMeaning,
} from '../../lib/scaling-view';

/**
 * The command people actually reach for, and they reach for it when *nothing*
 * happened. So a decline reads exactly like a purchase: same shape, same four
 * lines, same list of what lost. Filtering the declines out would remove the
 * only answer this command exists to give.
 *
 * The question is asked of a cluster, so that is what it answers by default.
 * Making somebody name a group first put the configuration in front of the
 * question — and on a cluster with two groups it made them guess which fleet
 * the silence belonged to before they were allowed to find out.
 */
export default class ScalingWhy extends Command {
  static readonly description =
    'The last scaling decision and its reason — including the times it decided to do nothing, ' +
    'which are the interesting ones.\n' +
    'Answers about the whole cluster by default, naming the group each decision came from. ' +
    'Name a group to narrow it to that one.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --cluster prod-eu',
    '<%= config.bin %> <%= command.id %> general --cluster prod-eu',
    '<%= config.bin %> <%= command.id %> --limit 10',
    '<%= config.bin %> <%= command.id %> --output json',
  ];

  static readonly args = {
    group: Args.string({
      description:
        'Scaling group name or ID (default: every group of the cluster)',
      required: false,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    limit: Flags.integer({
      char: 'n',
      description: 'How many decisions back to show, newest first',
      default: 1,
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ScalingWhy);
    const spinner = ora('Reading decisions...').start();
    const limit = Math.max(1, flags.limit);
    const json = flags.output === 'json';
    // The cluster route is newer than the rest of the surface, so an API one
    // build behind must not be reported as an API without scaling at all —
    // especially when naming a group still answers.
    let absent: string | undefined;

    try {
      const client = ScalingClient.open();

      if (args.group) {
        const { group } = await resolveGroup(client, flags.cluster, args.group);
        const decisions = await client.decisions(group.id, limit);
        spinner.stop();
        if (json) {
          console.log(JSON.stringify(decisions, null, 2));
          return;
        }
        this.printGroupHeader(group);
        this.printDecisions(decisions, describeSilence(group));
        return;
      }

      const cluster = await resolveClusterRef(flags.cluster);
      absent =
        'This installation’s API cannot answer this about a cluster: it is running a build without that route. ' +
        'Name a group instead — `flui scaling why <group> --cluster <cluster>`.';
      const decisions = await client.clusterDecisions(cluster.id, limit);
      if (json) {
        spinner.stop();
        console.log(JSON.stringify(decisions, null, 2));
        return;
      }
      // Only when there is nothing to show: "no group at all" and "no group has
      // been evaluated yet" are different answers and the decisions cannot tell
      // them apart, so the second read is bought exactly where it is needed.
      const groups = decisions.length ? [] : await client.groupsOf(cluster.id);
      spinner.stop();
      this.printClusterHeader(cluster.name, decisions.length);
      this.printDecisions(decisions, describeClusterSilence(groups));
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

  private printDecisions(
    decisions: Array<ScalingDecisionResponseDto | ClusterScalingDecisionDto>,
    silence: string[],
  ): void {
    if (!decisions.length) {
      for (const line of silence) console.log(`  ${chalk.dim(line)}`);
      console.log('');
      return;
    }
    for (const decision of decisions) {
      this.printDecision(decision);
    }
    if (decisions.some((d) => d.considered?.length)) {
      console.log(
        chalk.dim(
          `  ${NO_PRICE} is no price at all, not a price of zero. ` +
            '`refused-by-limit` is this group’s own rules, not the market.\n',
        ),
      );
    }
  }

  private printGroupHeader(group: ScalingGroupResponseDto): void {
    console.log('');
    console.log(
      `  ${chalk.cyan(chalk.bold(group.name))} ${chalk.dim(`on ${group.clusterName}`)}  ` +
        chalk.dim(`${formatBounds(group.bounds)} · ${group.provider}`),
    );
    console.log('');
  }

  private printClusterHeader(clusterName: string, shown: number): void {
    console.log('');
    console.log(
      `  ${chalk.cyan(chalk.bold(clusterName))}  ` +
        chalk.dim(
          shown
            ? `last ${shown} decision${shown === 1 ? '' : 's'} on this cluster, from any of its groups`
            : 'no decisions on this cluster yet',
        ),
    );
    console.log('');
  }

  private printDecision(
    decision: ScalingDecisionResponseDto | ClusterScalingDecisionDto,
  ): void {
    const view = describeDecision(decision);
    const from = groupNameOf(decision);
    console.log(
      `  ${from ? `${chalk.cyan(from)}  ` : ''}${this.colourHeadline(view)}  ` +
        chalk.dim(`${view.at} (${view.age})`),
    );
    console.log(`  ${chalk.dim(outcomeMeaning(decision.outcome))}`);
    console.log('');

    for (const line of view.lines) {
      const text = line.label === 'asks' ? chalk.yellow(line.text) : line.text;
      console.log(`    ${chalk.dim(line.label.padEnd(7))}${text}`);
    }

    if (view.candidates.length) {
      console.log('');
      console.log(
        chalk.dim(
          `    ${'SHAPE'.padEnd(12)} ${'REGION'.padEnd(10)} ${'PRICE'.padEnd(12)} WHY IT LOST`,
        ),
      );
      for (const candidate of view.candidates) {
        console.log(
          `    ${candidate.shape.padEnd(12)} ${candidate.region.padEnd(10)} ` +
            `${candidate.price.padEnd(12)} ${this.colourOutcome(candidate.outcome)} ${chalk.dim(candidate.reason)}`,
        );
      }
    }
    console.log('');
  }

  private colourHeadline(view: DecisionView): string {
    const headline = chalk.bold(view.headline);
    switch (view.outcome) {
      case 'alerted':
        return chalk.yellow(headline);
      case 'declined':
        return chalk.blue(headline);
      default:
        return chalk.green(headline);
    }
  }

  private colourOutcome(outcome: string): string {
    const cell = outcome.padEnd(17);
    if (outcome === 'would-buy') return chalk.green(cell);
    if (outcome === 'alert') return chalk.yellow(cell);
    return chalk.dim(cell);
  }
}

/** Present only on a decision read from the cluster, where it is what says whose it is. */
function groupNameOf(
  decision: ScalingDecisionResponseDto | ClusterScalingDecisionDto,
): string | null {
  return 'groupName' in decision ? decision.groupName : null;
}
