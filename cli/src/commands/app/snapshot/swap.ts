import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { confirmPrompt } from '../../../lib/prompts';

export default class AppSnapshotSwap extends Command {
  static readonly description =
    'Make the application use a restored volume (one created by `flui app snapshot restore`). The application restarts; the data it used before is kept as a separate volume until you delete it.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app my-app-data-restored-20260511',
    '<%= config.bin %> <%= command.id %> my-app my-app-data-restored-20260511 --volume data --yes',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    newPvcName: Args.string({
      description:
        'The restored volume (as printed by `flui app snapshot restore`)',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    volume: Flags.string({
      char: 'v',
      description: 'Application volume name (default: the single volume)',
    }),
    force: Flags.boolean({
      char: 'f',
      aliases: ['yes'],
      description: 'Skip confirmation (also --yes)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppSnapshotSwap);
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      const volumeName = flags.volume ?? 'data';
      if (!flags.force) {
        const ok = await confirmPrompt(
          `Make "${args.name}" use the restored volume ${args.newPvcName} for "${volumeName}"? The application restarts.`,
        );
        if (!ok) {
          console.log(chalk.dim('  Aborted.'));
          return;
        }
      }
      const spinner = ora(
        `Swapping ${volumeName} → ${args.newPvcName}...`,
      ).start();
      await service.swapAppVolume(app.id, volumeName, args.newPvcName);
      spinner.succeed(
        'The application now uses the restored volume and is restarting',
      );
      console.log(
        chalk.dim(
          `\n  The data it used before is kept as a separate volume: see \`flui app snapshot list --app ${args.name}\`.`,
        ),
      );
    } catch (error: any) {
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
