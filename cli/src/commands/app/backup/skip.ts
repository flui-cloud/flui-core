import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BackupClient } from '../../../lib/backup-client';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { CliAppService } from '../../../lib/services/cli-app.service';

export default class AppBackupSkip extends Command {
  static readonly description =
    'Decide that an application is not backed up. Flui stops asking for a ' +
    'backup of it and protecting its cluster gives it no policy; backups ' +
    'already taken and the policies naming it are left as they are.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-db',
    '<%= config.bin %> <%= command.id %> my-db --note "scratch copy of a restore"',
    '<%= config.bin %> <%= command.id %> my-db --undo',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name, slug or id',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    note: Flags.string({
      char: 'n',
      description: 'Why, in a few words (at most 500 characters).',
      exclusive: ['undo'],
    }),
    undo: Flags.boolean({
      default: false,
      description:
        'Take the decision back: the application is backed up again.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppBackupSkip);
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const app = await (
        await CliAppService.create(clusterId)
      ).getAppByName(args.name);
      const view = await BackupClient.fromConfig().setBackupDecision(app.id, {
        notBackedUp: !flags.undo,
        ...(flags.note ? { note: flags.note } : {}),
      });
      console.log('');
      if (!view.decision) {
        console.log(
          `  ${chalk.green('✓')} ${app.slug} is backed up again. Flui asks for a backup of it while it holds data.`,
        );
        console.log('');
        return;
      }
      console.log(
        `  ${chalk.green('✓')} ${app.slug} is not backed up, by choice${view.decision.note ? `: ${view.decision.note}` : ''}.`,
      );
      console.log(
        chalk.dim(
          '  Backups already taken and the policies naming it are left as they are.',
        ),
      );
      console.log(
        chalk.dim(
          `  flui app backup skip ${app.slug} --undo   back it up again`,
        ),
      );
      console.log('');
    } catch (error: any) {
      const msg = error.details?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  ${msg}\n`));
      this.exit(1);
    }
  }
}
