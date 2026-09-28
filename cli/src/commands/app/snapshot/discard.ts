import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { confirmPrompt } from '../../../lib/prompts';

export default class AppSnapshotDiscard extends Command {
  static readonly description =
    'Delete a restored or previous volume the application does not use ' +
    '(listed by `flui app snapshot list --app <app>`). Its data is gone for good.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app data-my-app-0-restored-20260926211450',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    volume: Args.string({
      description: 'The volume to delete',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    yes: Flags.boolean({
      char: 'y',
      aliases: ['force'],
      charAliases: ['f'],
      description: 'Skip confirmation (also --force, -f)',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppSnapshotDiscard);
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      if (!flags.yes) {
        const ok = await confirmPrompt(
          `Delete volume ${args.volume} of "${args.name}"? Its data cannot be recovered.`,
        );
        if (!ok) {
          console.log(chalk.dim('  Aborted.'));
          return;
        }
      }
      const spinner = ora(`Deleting ${args.volume}...`).start();
      await service.deleteSpareVolume(app.id, args.volume);
      spinner.succeed(`Deleted ${args.volume}`);
    } catch (error: any) {
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
