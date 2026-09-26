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
import type { ScalingGroupResponseDto } from 'src/modules/infrastructure/scaling/dto/scaling-response.dto';
import type { EditScalingGroupDto } from 'src/modules/infrastructure/scaling/dto/scaling-group.dto';
import { changeOf } from '../../lib/scaling-set';

export default class ScalingSet extends Command {
  static readonly description =
    'Change one or more settings of a scaling group and leave the rest as they are. The ceilings are kept unless you name them: changing the machines does not remove the monthly cap. --dry-run shows each setting before and after and writes nothing.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> default --max-monthly 30',
    '<%= config.bin %> <%= command.id %> default --provision manual',
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
        'Most the group may spend in a month, in euros; "none" removes the ceiling',
    }),
    'hourly-only': Flags.boolean({
      description: 'Buy only machines billed by the hour',
      allowNo: true,
    }),
    provision: Flags.string({
      description:
        'automatic: Flui buys on its own; manual: Flui proposes and a person buys',
      options: [...PROVISION_MODES],
    }),
    shapes: Flags.string({
      description: 'Machines the group may buy, comma separated',
    }),
    regions: Flags.string({
      description: 'Regions it may buy in, comma separated',
    }),
    min: Flags.integer({ description: 'Floor: fewest nodes, master included' }),
    desired: Flags.integer({
      description: 'Target: nodes it keeps without load',
    }),
    max: Flags.integer({ description: 'Ceiling: most nodes, master included' }),
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
      const client = ScalingClient.open();
      const { group } = await resolveGroup(client, flags.cluster, args.group);
      const change = changeOf(group, flags);
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
        console.log(chalk.dim('\n  Nothing was written (--dry-run).\n'));
        return;
      }

      const written = await client.update(group.id, change as never);
      console.log(
        `\n  ${chalk.green('✔')} ${written.name} changed. ${written.acts.says}\n`,
      );
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
