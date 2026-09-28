import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  ScalingClient,
  resolveGroup,
  scalingErrorLines,
} from '../../lib/scaling-client';

export default class ScalingFloor extends Command {
  static readonly description =
    "Add or remove a node: move the scaling group's floor (fewest nodes, master included). The target moves with it. A manual group then proposes the machine to buy or the node to give back, and `flui scaling approve --yes` carries it out; an automatic group acts on its own within its maximum of nodes and its spending ceiling.";

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> 3',
    '<%= config.bin %> <%= command.id %> 2 general --cluster prod-eu',
  ];

  static readonly args = {
    min: Args.integer({
      description: 'The new floor, master included',
      required: true,
    }),
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
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ScalingFloor);

    try {
      const client = ScalingClient.open();
      const { group } = await resolveGroup(client, flags.cluster, args.group);
      const saved = await client.setFloor(group.id, args.min);
      const { min, desired, max } = saved.bounds;
      console.log(
        chalk.green(
          `\n  ✔ ${saved.name}: min ${min} · target ${desired} · max ${max} nodes`,
        ),
      );
      console.log(`  ${saved.acts.says}`);
      if (!saved.acts.acts) {
        console.log(
          chalk.dim(
            '  See what it proposes: flui scaling approve — then add --yes to carry it out.\n',
          ),
        );
      } else {
        console.log('');
      }
    } catch (error: unknown) {
      console.log('');
      for (const line of scalingErrorLines(error)) {
        console.log(chalk.red(`  ${line}`));
      }
      console.log('');
      this.exit(1);
    }
  }
}
