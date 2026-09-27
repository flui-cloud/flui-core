import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  ScalingClient,
  resolveGroup,
  scalingErrorLines,
} from '../../lib/scaling-client';

export default class ScalingDelete extends Command {
  static readonly description =
    'Remove a scaling group and the decisions it took. No node is removed and no machine stops. The only group of a cluster Flui buys for cannot be removed: its nodes change through it.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> heavy --cluster prod-eu --yes',
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
    yes: Flags.boolean({
      char: 'y',
      description: 'Remove it without asking',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ScalingDelete);

    try {
      const client = ScalingClient.open();
      const { group } = await resolveGroup(client, flags.cluster, args.group);
      if (!flags.yes) {
        console.log(
          chalk.yellow(
            `\n  This removes ${group.name} and its decision log. Run again with --yes.\n`,
          ),
        );
        return;
      }
      await client.remove(group.id);
      console.log(chalk.green(`\n  ✔ Removed ${group.name}.\n`));
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
