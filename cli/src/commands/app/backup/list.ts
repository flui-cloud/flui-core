import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { VolumeBackupClient } from '../../../lib/volume-backup-client';
import {
  VOLUME_BACKUP_HEADERS,
  renderTable,
  volumeBackupColumns,
} from '../../../lib/volume-backup-format';

export default class AppBackupList extends Command {
  static readonly description =
    "List an application's volume backups, newest first: kopia snapshots, archives taken before kopia, and clones on the cluster. SIZE is what a restore writes back, ADDED what the backup added to the destination.";

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app',
    '<%= config.bin %> <%= command.id %> my-app -o json',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    output: Flags.string({
      char: 'o',
      description: 'Output format',
      options: ['table', 'json'],
      default: 'table',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppBackupList);
    const spinner = ora('Fetching volume backups...').start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const app = await (
        await CliAppService.create(clusterId)
      ).getAppByName(args.name);
      const backups = await VolumeBackupClient.create().list(app.id);
      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(backups, null, 2));
        return;
      }
      if (backups.length === 0) {
        console.log(chalk.dim(`  No volume backups for ${app.name}.`));
        console.log(
          chalk.dim(
            `  Take one with: flui app backup create ${app.name} -D <destination>`,
          ),
        );
        return;
      }
      console.log('');
      const [head, ...rows] = renderTable(
        VOLUME_BACKUP_HEADERS,
        backups.map(volumeBackupColumns),
      );
      console.log(`  ${chalk.bold(head)}`);
      for (const row of rows) console.log(`  ${row}`);
      console.log('');
      console.log(
        chalk.dim(
          `  Look inside:  flui app backup browse ${app.name} <id> [path]\n` +
            `  Restore:      flui app backup restore ${app.name} <id> [--swap | --path <p>]`,
        ),
      );
      console.log('');
    } catch (error: any) {
      spinner.fail('Failed to list volume backups');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
