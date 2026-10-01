import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { BackupClient } from '../../../lib/backup-client';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { CliAppService } from '../../../lib/services/cli-app.service';

export default class AppBackupBeforeDeploy extends Command {
  static readonly description =
    'Take a backup before each deploy of an application: a restore point for a ' +
    'database with continuous backup (the deploy waits the few seconds it takes), ' +
    'a dump for one kept by dumps and a copy of the other volumes (started, not ' +
    'waited for). It uses the policies that already protect the application.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app',
    '<%= config.bin %> <%= command.id %> my-app --required',
    '<%= config.bin %> <%= command.id %> my-app --off',
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
    off: Flags.boolean({
      default: false,
      description: 'Stop taking a backup before each deploy.',
      exclusive: ['required'],
    }),
    required: Flags.boolean({
      default: false,
      description:
        'Fail the deploy when the backup before it cannot be taken. Without it the deploy goes ahead and the failure is logged.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppBackupBeforeDeploy);
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const app = await (
        await CliAppService.create(clusterId)
      ).getAppByName(args.name);
      const option = await BackupClient.fromConfig().setBeforeDeploy(app.id, {
        enabled: !flags.off,
        required: flags.required,
      });
      console.log('');
      if (!option.enabled) {
        console.log(
          `  ${chalk.green('✓')} Deploys of ${app.slug} no longer take a backup first.`,
        );
        console.log('');
        return;
      }
      const takes = [
        option.takes.restorePoint ? 'a restore point of the database' : '',
        option.takes.dump ? 'a dump of the database' : '',
        option.takes.volumes ? 'a copy of the other volumes' : '',
      ].filter(Boolean);
      console.log(
        `  ${chalk.green('✓')} Each deploy of ${app.slug} first takes ${takes.length ? takes.join(', ') : 'nothing yet'}${option.required ? ', and fails if it cannot' : ''}.`,
      );
      if (option.warning) console.log(chalk.yellow(`\n  ! ${option.warning}`));
      console.log('');
    } catch (error: any) {
      const msg = error.details?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  ${msg}\n`));
      this.exit(1);
    }
  }
}
