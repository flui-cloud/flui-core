import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';

export default class AppSnapshotRestore extends Command {
  static readonly description =
    'Restore a copy into a new volume beside the application. The application is not touched until you make it use the new volume with --swap or `flui app snapshot swap`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app my-app-snap-20260510-abcdef',
    '<%= config.bin %> <%= command.id %> my-app my-app-snap-... --swap',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    snapshotId: Args.string({
      description: 'Snapshot id (from `flui app snapshot list`)',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    swap: Flags.boolean({
      description:
        'Make the application use the restored volume right away (it restarts). The data it used before is kept as a separate volume.',
    }),
    volume: Flags.string({
      char: 'v',
      description:
        'Application volume name to swap when --swap is set. Required if the app has multiple volumes.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppSnapshotRestore);
    const spinner = ora(`Restoring snapshot ${args.snapshotId}...`).start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const result = await service.restoreAppSnapshot(app.id, args.snapshotId);
      spinner.succeed(`Restored into a new volume: ${result.newPvcName}`);

      console.log('');
      console.log(`  ${chalk.bold('App:')}        ${app.name}`);
      console.log(`  ${chalk.bold('From snap:')}  ${args.snapshotId}`);
      console.log(`  ${chalk.bold('New volume:')} ${result.newPvcName}`);

      if (flags.swap) {
        const volumeName = flags.volume ?? 'data';
        const swapSpinner = ora(
          `Swapping volume "${volumeName}" to ${result.newPvcName}...`,
        ).start();
        try {
          await service.swapAppVolume(app.id, volumeName, result.newPvcName);
        } catch (swapError: any) {
          swapSpinner.fail('Swap failed');
          // Created by this command a moment ago and never used: leaving it
          // would be a full volume paid for that nobody asked to keep.
          await service
            .deleteSpareVolume(app.id, result.newPvcName)
            .then(() =>
              console.log(
                chalk.dim(
                  `  Removed the restored volume ${result.newPvcName}.`,
                ),
              ),
            )
            .catch(() =>
              console.log(
                chalk.yellow(
                  `  The restored volume ${result.newPvcName} is still there: flui app snapshot discard ${app.name} ${result.newPvcName}`,
                ),
              ),
            );
          throw swapError;
        }
        swapSpinner.succeed(
          'The application now uses the restored volume and is restarting',
        );
        console.log(
          chalk.dim(
            `\n  The data it used before is kept as a separate volume: see \`flui app snapshot list --app ${app.name}\`.`,
          ),
        );
      } else {
        console.log('');
        console.log(chalk.dim('  Next steps:'));
        console.log(
          chalk.dim(
            `  flui app snapshot swap ${app.name} ${result.newPvcName}`,
          ),
        );
      }
    } catch (error: any) {
      spinner.fail('Restore failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
