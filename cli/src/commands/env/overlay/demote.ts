import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ManagementNetworkClient } from '../../../lib/management-network-client';
import { resolveClusterRef } from '../../../lib/resolve-cluster';

export default class EnvOverlayDemote extends Command {
  static readonly description =
    'Emergency: move a cluster’s API address back to its public address, off the Flui network, and hold it there until released with --release. Flui never does this on its own.';

  static readonly summary = 'Address a cluster on its public path again';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> workload-1 --yes',
    '<%= config.bin %> <%= command.id %> workload-1 --release',
  ];

  static readonly args = {
    cluster: Args.string({
      description: 'Cluster name or ID',
      required: true,
    }),
  };

  static readonly flags = {
    release: Flags.boolean({
      description:
        'Release the hold: the cluster goes back on the Flui network once every control node reaches it there',
      default: false,
    }),
    yes: Flags.boolean({
      description: 'Skip the confirmation',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(EnvOverlayDemote);
    try {
      const { id, name } = await resolveClusterRef(args.cluster);
      const client = ManagementNetworkClient.open();
      if (flags.release) {
        await client.release(id);
        console.log(
          `\n  ${chalk.bold(name)} is no longer held on its public address. It moves back to the Flui network once every control node reaches it there.\n`,
        );
        return;
      }
      if (!flags.yes) {
        console.log(
          `\n  This points Flui at ${chalk.bold(name)}'s public address and reopens its API port to the control nodes.\n` +
            chalk.dim(
              '  It stays there until you run this again with --release.\n  Re-run with --yes to proceed.\n',
            ),
        );
        return;
      }
      const result = await client.demote(id);
      const moved = result.changed
        ? `moved from ${result.from} to ${result.to}`
        : `already on ${result.to}`;
      console.log(
        `\n  ${chalk.green('✓')} ${chalk.bold(result.clusterName)}: API address ${moved}, held off the Flui network.\n`,
      );
    } catch (error: any) {
      console.log(chalk.red(`\n  Error: ${error.message}\n`));
      this.exit(1);
    }
  }
}
