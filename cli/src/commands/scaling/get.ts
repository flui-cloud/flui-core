import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import type {
  ScalingGroupResponseDto,
  StandingOrderResponseDto,
} from 'src/modules/infrastructure/scaling/dto/scaling-response.dto';
import {
  ScalingClient,
  resolveGroup,
  scalingErrorLines,
} from '../../lib/scaling-client';
import { dumpScalingGroupDocument } from '../../lib/scaling-file';
import {
  NO_PRICE,
  boundRows,
  describeActuation,
  describeCapability,
  describeDrain,
  describeSettle,
  describeStandingOrder,
  describeStrategy,
  formatEurPerMonth,
  toScalingGroupDocument,
} from '../../lib/scaling-view';

export default class ScalingGet extends Command {
  static readonly description =
    'Show a scaling group: its three bounds, where and what it may buy, and what it may spend.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> general --cluster prod-eu',
    '<%= config.bin %> <%= command.id %> --output yaml',
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
      options: ['table', 'json', 'yaml'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ScalingGet);

    try {
      const client = ScalingClient.open();
      const { group } = await resolveGroup(client, flags.cluster, args.group);

      if (flags.output === 'json') {
        console.log(JSON.stringify(group, null, 2));
        return;
      }
      if (flags.output === 'yaml') {
        process.stdout.write(
          dumpScalingGroupDocument(toScalingGroupDocument(group)),
        );
        return;
      }
      this.print(group);
    } catch (error: unknown) {
      console.log('');
      for (const line of scalingErrorLines(error)) {
        console.log(chalk.red(`  ${line}`));
      }
      console.log('');
      this.exit(1);
    }
  }

  private print(group: ScalingGroupResponseDto): void {
    console.log('');
    console.log(
      `  ${chalk.cyan(chalk.bold(group.name))}  ${chalk.dim(`on ${group.clusterName} · ${group.provider}`)}`,
    );
    console.log(`  ${chalk.dim(describeCapability(group.capability))}`);
    console.log('');

    for (const row of boundRows(group.bounds, group.provision)) {
      console.log(
        `  ${row.role.padEnd(9)}${chalk.dim(row.field.padEnd(10))}${chalk.bold(
          String(row.value).padEnd(4),
        )}${chalk.dim(row.meaning)}`,
      );
    }
    console.log('');

    console.log(
      `  ${'regions'.padEnd(11)}${group.regions.length ? group.regions.join(', ') : chalk.dim('none named')}`,
    );
    console.log(
      `  ${'shapes'.padEnd(11)}${
        group.shapes.length
          ? group.shapes.join(chalk.dim(' → ')) +
            chalk.dim('   (in order of preference)')
          : chalk.dim('none named')
      }`,
    );
    console.log(
      `  ${'strategy'.padEnd(11)}${group.strategy}  ${chalk.dim(describeStrategy(group.strategy))}`,
    );
    console.log(
      `  ${'settle'.padEnd(11)}${chalk.dim(describeSettle(group.settleSeconds))}`,
    );
    console.log(`  ${'limits'.padEnd(11)}${this.limitsLine(group)}`);
    console.log(`  ${'provision'.padEnd(11)}${group.provision}`);
    this.printActuation(group);

    if (group.requirement) {
      console.log(
        `  ${'requirement'.padEnd(11)}${group.requirement.cpu} cpu · ${group.requirement.memory}  ` +
          chalk.dim(
            '(what a machine has to hold, since no catalogue names shapes here)',
          ),
      );
    }

    this.printOrders(group.standingOrders ?? []);
    console.log('');
  }

  private limitsLine(group: ScalingGroupResponseDto): string {
    const parts: string[] = [];
    parts.push(
      group.limits.hourlyBillingOnly
        ? 'hourly-billed shapes only'
        : chalk.dim('any billing'),
    );
    parts.push(
      group.limits.maxMonthlyCost === null
        ? chalk.dim(`no monthly ceiling (${NO_PRICE}, which is not 0)`)
        : `at most ${formatEurPerMonth(group.limits.maxMonthlyCost)}`,
    );
    return parts.join(chalk.dim(' · '));
  }

  /**
   * The one question somebody opening this actually has: will this group do
   * anything? Two keys turn the lock — the group's own mode and the grant the
   * installation made — so the answer is the API's sentence, not a rephrasing
   * of the `provision` field printed above it.
   */
  private printActuation(group: ScalingGroupResponseDto): void {
    const acting = describeActuation(group);
    if (!acting) return;
    const verdict = acting.acts
      ? chalk.green(acting.verdict)
      : chalk.yellow(acting.verdict);
    const grant = chalk.dim('grant ' + acting.grant);
    console.log(`  ${'acts'.padEnd(11)}${verdict}   ${grant}`);
    console.log(`  ${' '.repeat(11)}${chalk.dim(acting.says)}`);
  }

  private printOrders(orders: StandingOrderResponseDto[]): void {
    if (!orders.length) return;
    console.log('');
    console.log(`  ${chalk.dim('standing orders')}`);
    for (const order of orders) {
      console.log(`    ${order.kind.padEnd(8)}${describeStandingOrder(order)}`);
      this.printDrain(order);
    }
  }

  /**
   * A replacement whose drain is refused waits for a machine it will never buy.
   * Nothing else on this screen tells that apart from patience, so the blockers
   * are named here with what would have to change for each one.
   */
  private printDrain(order: StandingOrderResponseDto): void {
    const drain = describeDrain(order.drainable);
    if (!drain) return;
    const mark = drain.ok ? chalk.green('✔') : chalk.yellow('⚠');
    console.log(`            ${mark} ${chalk.dim(drain.headline)}`);
    for (const blocker of drain.blockers) {
      console.log(`              ${chalk.bold(blocker.what)}`);
      console.log(`                ${chalk.dim(blocker.fix)}`);
    }
  }
}
