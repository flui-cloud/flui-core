import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import type {
  ClusterScalingRowDto,
  ScalingGroupResponseDto,
} from 'src/modules/infrastructure/scaling/dto/scaling-response.dto';
import { resolveClusterRef } from '../../lib/resolve-cluster';
import { ScalingClient, scalingErrorLines } from '../../lib/scaling-client';
import {
  FLOOR_MARK,
  NO_ANSWER,
  NO_PRICE,
  capabilityLabel,
  describeActuation,
  describeCapability,
  describeMonthlySpend,
  formatEur,
  formatEurPerMonth,
  groupNames,
  monthlySpendCell,
  pendingPodsCell,
  pendingPodsWarns,
  rowAttention,
} from '../../lib/scaling-view';

export default class ScalingList extends Command {
  static readonly description =
    'One line per cluster: what it may buy, what it is spending, and what is waiting.\n' +
    'Clusters with no scaling group are listed too, and so are the ones that can only raise an alarm — ' +
    'the two cases a filter would hide precisely when somebody is needed.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --cluster prod-eu',
    '<%= config.bin %> <%= command.id %> --output json',
  ];

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Show the scaling groups of one cluster instead',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(ScalingList);
    const spinner = ora('Reading scaling groups...').start();

    try {
      const client = ScalingClient.open();

      if (flags.cluster) {
        const cluster = await resolveClusterRef(flags.cluster);
        // The row already names every group, so nothing here waits on the
        // second read to know what exists. It is asked because this table also
        // says what each group may buy and may spend, and the row carries
        // neither — the two are read together rather than one after the other.
        const [row, groups] = await Promise.all([
          client.rowFor(cluster.id),
          client.groupsOf(cluster.id),
        ]);
        spinner.stop();
        if (flags.output === 'json') {
          console.log(JSON.stringify(groups, null, 2));
          return;
        }
        this.printGroups(row, groups);
        return;
      }

      const rows = await client.rows();
      spinner.stop();
      if (flags.output === 'json') {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      this.printRows(rows);
    } catch (error: unknown) {
      spinner.stop();
      console.log('');
      for (const line of scalingErrorLines(error)) {
        console.log(chalk.red(`  ${line}`));
      }
      console.log('');
      this.exit(1);
    }
  }

  private printRows(rows: ClusterScalingRowDto[]): void {
    console.log('');
    if (!rows.length) {
      console.log(chalk.yellow('  No clusters.\n'));
      return;
    }

    console.log(
      chalk.dim(
        `  ${'CLUSTER'.padEnd(20)} ${'SCALING'.padEnd(18)} ${'GROUPS'.padEnd(22)} ` +
          `${'NODES'.padEnd(6)} ${'BOUNDS'.padEnd(12)} ${'MONTHLY'.padEnd(18)} WAITING`,
      ),
    );
    console.log(chalk.dim('  ' + '─'.repeat(110)));

    for (const row of rows) {
      const bounds = row.bounds
        ? `${row.bounds.min}/${row.bounds.desired}/${row.bounds.max}`
        : chalk.dim('no group');
      const cell = pendingPodsCell(row);
      const waiting = pendingPodsWarns(row)
        ? chalk.yellow(cell)
        : chalk.dim(cell);
      console.log(
        `  ${truncate(row.clusterName, 20).padEnd(20)} ` +
          `${this.capabilityCell(row)} ` +
          `${truncate(groupNames(row), 22).padEnd(22)} ` +
          `${String(row.nodes).padEnd(6)} ` +
          `${padVisible(bounds, 12)} ` +
          `${padVisible(this.spendCell(row), 18)} ${waiting}`,
      );
    }

    const attention = rows
      .map((row) => ({ row, line: rowAttention(row) }))
      .filter((entry) => entry.line);
    if (attention.length) {
      console.log('');
      for (const entry of attention) {
        console.log(
          `  ${chalk.yellow('⚠')} ${chalk.bold(entry.row.clusterName)}  ${entry.line}`,
        );
      }
    }

    const blocked = rows.filter((row) => row.blockedOrders > 0);
    for (const row of blocked) {
      console.log(
        `  ${chalk.yellow('⚠')} ${chalk.bold(row.clusterName)}  ` +
          `${row.blockedOrders} standing order${row.blockedOrders === 1 ? '' : 's'} held back: ` +
          'the node it would empty cannot be emptied',
      );
    }

    console.log('');
    console.log(
      chalk.dim(
        '  BOUNDS is floor/target/ceiling. The floor is held now and always; the target is only\n' +
          '  approached when the market allows; the ceiling is as far as urgency may go right now.\n' +
          '  A ceiling of 0 is a fleet that should hold no nodes, not a group switched off.',
      ),
    );
    console.log(
      chalk.dim(
        `  ${NO_PRICE} under MONTHLY is no figure at all, never €0: on machines Flui is not billed for\n` +
          '  there is no bill and never will be, and elsewhere it means no node carries a price yet.',
      ),
    );
    if (rows.some((row) => row.monthlyEur !== null && row.unpricedNodes > 0)) {
      console.log(
        chalk.dim(
          `  A figure marked ${FLOOR_MARK} is a floor, not the bill: some of those nodes carry no price\n` +
            '  and add nothing to it.',
        ),
      );
    }
    if (rows.some((row) => row.pendingPods === null)) {
      console.log(
        chalk.dim(
          `  ${NO_ANSWER} under WAITING is no answer, never 0: no group of that cluster could find out\n` +
            '  what the scheduler could not place, so nothing is known about what is waiting there.',
        ),
      );
    }
    console.log('');
  }

  private capabilityCell(row: ClusterScalingRowDto): string {
    const label = capabilityLabel(row.capability);
    const cell = label.padEnd(18);
    return row.capability.canProvision ? cell : chalk.yellow(cell);
  }

  private spendCell(row: ClusterScalingRowDto): string {
    const spend = monthlySpendCell(row);
    if (row.monthlyCap === null) return spend;
    return `${spend} of ${formatEur(row.monthlyCap)}`;
  }

  private printGroups(
    row: ClusterScalingRowDto,
    groups: ScalingGroupResponseDto[],
  ): void {
    console.log('');
    console.log(
      `  ${chalk.cyan(chalk.bold(row.clusterName))}  ${chalk.dim(`${row.nodes} node${row.nodes === 1 ? '' : 's'}`)}`,
    );
    console.log(`  ${chalk.dim(describeCapability(row.capability))}`);
    console.log(`  ${chalk.dim(describeMonthlySpend(row))}`);
    console.log('');

    if (!groups.length) {
      console.log(
        chalk.yellow('  No scaling group on this cluster.') +
          chalk.dim(' Write one with `flui scaling apply -f <file>`.\n'),
      );
      return;
    }

    console.log(
      chalk.dim(
        `  ${'NAME'.padEnd(20)} ${'BOUNDS'.padEnd(12)} ${'STRATEGY'.padEnd(10)} ` +
          `${'PROVISION'.padEnd(11)} ${'CAP'.padEnd(12)} SHAPES`,
      ),
    );
    console.log(chalk.dim('  ' + '─'.repeat(96)));

    for (const group of groups) {
      const bounds = `${group.bounds.min}/${group.bounds.desired}/${group.bounds.max}`;
      const cap = formatEurPerMonth(group.limits.maxMonthlyCost);
      const shapes = group.shapes.length
        ? group.shapes.join(' → ')
        : group.requirement
          ? `needs ${group.requirement.cpu} cpu · ${group.requirement.memory}`
          : 'none named';
      console.log(
        `  ${truncate(group.name, 20).padEnd(20)} ${bounds.padEnd(12)} ` +
          `${group.strategy.padEnd(10)} ${group.provision.padEnd(11)} ${cap.padEnd(12)} ${shapes}`,
      );
    }

    // PROVISION is what somebody wrote; whether it reaches a provider is the
    // group's own mode *and* the grant this installation made. A group listed as
    // automatic that buys nothing is the case that looks armed and is not.
    for (const group of groups) {
      const acting = describeActuation(group);
      if (!acting || acting.acts || group.provision !== 'automatic') continue;
      console.log('');
      console.log(
        `  ${chalk.yellow('⚠')} ${chalk.bold(group.name)}  ${acting.says}`,
      );
    }

    const attention = rowAttention(row);
    if (attention) {
      console.log('');
      console.log(`  ${chalk.yellow('⚠')} ${attention}`);
    }
    console.log('');
  }
}

function truncate(value: string, width: number): string {
  return value.length > width ? value.slice(0, width - 1) + '…' : value;
}

/** Pads to a visible width, ignoring the colour codes a cell may already carry. */
function padVisible(cell: string, width: number): string {
  // eslint-disable-next-line no-control-regex
  const visible = cell.replace(/\u001b\[[0-9;]*m/g, '').length;
  return cell + ' '.repeat(Math.max(0, width - visible));
}
