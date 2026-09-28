import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  ScalingClient,
  resolveGroup,
  scalingErrorLines,
} from '../../lib/scaling-client';
import { groupChanges } from 'src/modules/infrastructure/scaling/services/group-changes.core';
import {
  PLACEMENT_STRATEGIES,
  PROVISION_MODES,
} from 'src/modules/infrastructure/scaling/scaling.core';
import type {
  ScalingCostDto,
  ScalingGroupResponseDto,
} from 'src/modules/infrastructure/scaling/dto/scaling-response.dto';
import type { EditScalingGroupDto } from 'src/modules/infrastructure/scaling/dto/scaling-group.dto';
import { changeOf } from '../../lib/scaling-set';
import { boundProblem, costLines } from '../../lib/scaling-view';

function hasSpendingCeiling(maxMonthlyCost: unknown): boolean {
  return Number(maxMonthlyCost) > 0;
}

function printCost(cost: ScalingCostDto | null | undefined): void {
  const lines = costLines(cost);
  if (!lines) return;
  console.log('');
  console.log(`  ${chalk.dim(lines.says)}`);
  for (const line of lines.scenarios) {
    console.log(`    ${line.label.padEnd(46)}${chalk.bold(line.value)}`);
  }
  console.log(
    `  ${lines.ceilingStops ? chalk.yellow(lines.ceiling) : chalk.dim(lines.ceiling)}`,
  );
}

export default class ScalingSet extends Command {
  static readonly description =
    'Change one or more settings of a scaling group and leave the rest as they are. Limits are in nodes (--min, --max); the cost follows and is shown as scenarios. The spending ceiling (--max-monthly) is the safety net underneath, required to buy automatically, and kept unless you name it. --dry-run shows each setting before and after, with what the limits would cost, and writes nothing.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> default --max-monthly 30',
    '<%= config.bin %> <%= command.id %> default --provision manual',
    '<%= config.bin %> <%= command.id %> default --provision automatic --max-monthly 40',
    '<%= config.bin %> <%= command.id %> default --shapes cx33,cx23 --regions fsn1,nbg1 --dry-run',
    '<%= config.bin %> <%= command.id %> default --max 4 --desired 2',
    '<%= config.bin %> <%= command.id %> default --max-monthly none',
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
    'max-monthly': Flags.string({
      description:
        'Spending ceiling in euros a month: the safety net the engine checks before every purchase. "none" removes it (only on a manual group: automatic needs one)',
    }),
    'hourly-only': Flags.boolean({
      description: 'Buy only machines billed by the hour',
      allowNo: true,
    }),
    provision: Flags.string({
      description:
        'automatic: Flui buys on its own up to --max nodes, never past the spending ceiling (required); manual: Flui proposes and a person buys',
      options: [...PROVISION_MODES],
    }),
    shapes: Flags.string({
      description: 'Machines the group may buy, comma separated',
    }),
    regions: Flags.string({
      description: 'Regions it may buy in, comma separated',
    }),
    min: Flags.integer({
      description: 'Min nodes: fewest, master included (1-20)',
    }),
    desired: Flags.integer({
      description: 'Target: nodes it keeps without load',
    }),
    max: Flags.integer({
      description: 'Max nodes: most, master included (1-20)',
    }),
    strategy: Flags.string({
      description: 'How it picks among machines that fit',
      options: [...PLACEMENT_STRATEGIES],
    }),
    settle: Flags.integer({
      description: 'Seconds an app must wait for room before the group acts',
    }),
    'dry-run': Flags.boolean({
      description: 'Show each setting before and after; write nothing',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ScalingSet);

    try {
      for (const [flag, value] of [
        ['min', flags.min],
        ['desired', flags.desired],
        ['max', flags.max],
      ] as const) {
        const problem = boundProblem(flag, value);
        if (problem) this.error(problem);
      }
      const client = ScalingClient.open();
      const { group } = await resolveGroup(client, flags.cluster, args.group);
      const change = changeOf(group, flags);
      const next = merged(group, change);
      if (
        next.provision === 'automatic' &&
        !hasSpendingCeiling(next.limits.maxMonthlyCost)
      ) {
        const suggested = group.cost?.suggestedCeilingEur;
        this.error(
          'Buying automatically needs a spending ceiling, the safety net checked before every purchase.' +
            (suggested
              ? ` One covering this group's worst case: --max-monthly ${suggested}`
              : ' Pass --max-monthly.'),
        );
      }
      if (!Object.keys(change).length) {
        this.error(
          'Nothing to change: pass at least one setting (see --help).',
        );
      }

      const lines = groupChanges(
        fieldsOf(group),
        fieldsOf(merged(group, change)),
      );
      console.log('');
      if (!lines.length) {
        console.log(
          chalk.dim(
            `  ${group.name} already has these settings; nothing to write.\n`,
          ),
        );
        return;
      }
      for (const line of lines) console.log(`  ${chalk.cyan('•')} ${line}`);

      if (flags['dry-run']) {
        const cost = await client.cost(group.clusterId, {
          bounds: { min: next.bounds.min, max: next.bounds.max },
          shapes: next.shapes,
          regions: next.regions,
          maxMonthlyCost: next.limits.maxMonthlyCost,
        });
        printCost(cost);
        console.log(chalk.dim('\n  Nothing was written (--dry-run).\n'));
        return;
      }

      const written = await client.update(group.id, change as never);
      console.log(
        `\n  ${chalk.green('✔')} ${written.name} changed. ${written.acts.says}`,
      );
      printCost(written.cost);
      console.log('');
    } catch (error: unknown) {
      console.log('');
      for (const line of scalingErrorLines(error)) console.log(line);
      console.log('');
      process.exitCode = 1;
    }
  }
}

function merged(
  group: ScalingGroupResponseDto,
  change: EditScalingGroupDto,
): ScalingGroupResponseDto {
  return {
    ...group,
    ...(change.bounds ? { bounds: change.bounds as never } : {}),
    ...(change.limits ? { limits: change.limits as never } : {}),
    ...(change.provision ? { provision: change.provision } : {}),
    ...(change.shapes ? { shapes: change.shapes } : {}),
    ...(change.regions ? { regions: change.regions } : {}),
    ...(change.strategy ? { strategy: change.strategy } : {}),
    ...(change.settleSeconds !== undefined
      ? { settleSeconds: change.settleSeconds }
      : {}),
  };
}

function fieldsOf(group: ScalingGroupResponseDto) {
  return {
    name: group.name,
    minNodes: group.bounds.min,
    desiredNodes: group.bounds.desired,
    maxNodes: group.bounds.max,
    regions: group.regions,
    shapes: group.shapes,
    strategy: group.strategy,
    settleSeconds: group.settleSeconds,
    hourlyBillingOnly: group.limits.hourlyBillingOnly,
    maxMonthlyCost: group.limits.maxMonthlyCost ?? null,
    provision: group.provision,
    standingOrders: [] as never[],
    requirement: null,
  } as never;
}
