import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { BackupClient } from '../../../lib/backup-client';
import { printContextBanner } from '../../../lib/context-banner';

export default class BackupDestinationUpgradeLayout extends Command {
  static readonly description =
    'Give cluster backups a folder of their own in a destination created before ' +
    'each kind of backup had one. Needed when database, volume or platform backups ' +
    'share the destination with cluster backups, which makes it unusable for them. ' +
    'Nothing is moved: cluster backups already stored are listed with the commands to move them.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> a83dad2e-…',
    '<%= config.bin %> <%= command.id %> a83dad2e-… --force',
  ];

  static readonly args = {
    id: Args.string({ required: true, description: 'Destination ID' }),
  };

  static readonly flags = {
    force: Flags.boolean({
      description:
        'Switch even though cluster backups are stored at the top: they stay in the bucket but are no longer listed or restorable until moved',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BackupDestinationUpgradeLayout);
    printContextBanner();
    const client = BackupClient.fromConfig();
    const spinner = ora(`Updating destination ${args.id}...`).start();
    try {
      const res = await client.upgradeDestinationLayout(args.id, flags.force);
      if (!res.changed) {
        spinner.succeed('Cluster backups already have their own folder here');
        return;
      }
      spinner.succeed(
        'Cluster backups now go to their own folder (velero/); each cluster switches on its next backup or restore',
      );
      if (res.leftBehind.length) {
        const folders = res.leftBehind.map((d) => d + '/').join(', ');
        this.log(
          chalk.yellow(
            `  Left where they were, and no longer listed until moved into velero/: ${folders}`,
          ),
        );
      }
    } catch (err: any) {
      const msg = err?.response?.data?.message ?? err?.message ?? String(err);
      spinner.fail('Not changed');
      this.log(chalk.red(`\n  ${msg}\n`));
      this.exit(1);
    }
  }
}
