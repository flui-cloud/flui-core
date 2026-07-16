import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { confirmPrompt } from '../../../lib/prompts';

export default class AppSnapshotDelete extends Command {
  static readonly description = 'Delete a volume snapshot of an application.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app my-app-snap-20260510-abcdef',
    '<%= config.bin %> <%= command.id %> my-app my-app-snap-... --force',
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
    force: Flags.boolean({
      char: 'f',
      description: 'Skip confirmation',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppSnapshotDelete);
    if (!flags.force) {
      const ok = await confirmPrompt(
        `Delete snapshot "${args.snapshotId}" of app "${args.name}"?`,
      );
      if (!ok) {
        console.log(chalk.dim('  Aborted.'));
        return;
      }
    }
    const spinner = ora(`Deleting snapshot ${args.snapshotId}...`).start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      await service.deleteAppSnapshot(app.id, args.snapshotId);
      spinner.succeed(`Deleted snapshot ${args.snapshotId}`);
    } catch (error: any) {
      spinner.fail('Snapshot deletion failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
