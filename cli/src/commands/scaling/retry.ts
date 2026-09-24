import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import {
  ScalingClient,
  resolveGroup,
  scalingErrorLines,
} from '../../lib/scaling-client';

export default class ScalingRetry extends Command {
  static readonly description =
    'Let a scaling group buy again after a purchase failed. A failed purchase holds the group back so it is not retried every minute; run this once the cause is fixed. It buys nothing by itself — the next pass may, inside the same limits.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> general --cluster prod-eu',
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
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(ScalingRetry);

    try {
      const client = ScalingClient.open();
      const { group } = await resolveGroup(client, flags.cluster, args.group);

      if (!group.purchaseHeld) {
        console.log(
          chalk.dim(
            `\n  ${group.name} is not held back: no failed purchase is waiting on anyone.\n`,
          ),
        );
        return;
      }

      const after = await client.retryPurchase(group.id);
      console.log(
        chalk.green(`\n  ✔ ${after.name} may buy again from its next pass.`),
      );
      console.log(
        chalk.dim(
          '  If the cause is still there, the next purchase fails the same way and it holds back again.',
        ),
      );
      console.log(
        chalk.dim('  Follow what it decides with `flui scaling why`.\n'),
      );
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
