import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { CliAppService } from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import {
  VolumeBackupClient,
  resolveBackupId,
} from '../../../lib/volume-backup-client';
import { entryColumns, renderTable } from '../../../lib/volume-backup-format';

export default class AppBackupBrowse extends Command {
  static readonly description =
    'List a directory inside a kopia volume backup, read-only. Use it to find the paths to give `flui app backup restore --path`.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app 3f2a91c0',
    '<%= config.bin %> <%= command.id %> my-app 3f2a91c0 uploads/2026',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    backup: Args.string({
      description:
        'Backup id, or its first characters (from `flui app backup list`)',
      required: true,
    }),
    path: Args.string({
      description: 'Directory inside the volume (default: the root)',
      required: false,
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
    const { args, flags } = await this.parse(AppBackupBrowse);
    const spinner = ora('Opening the backup...').start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const app = await (
        await CliAppService.create(clusterId)
      ).getAppByName(args.name);
      const client = VolumeBackupClient.create();
      const backup = resolveBackupId(await client.list(app.id), args.backup);
      const listing = await client.browse(app.id, backup.id, args.path);
      spinner.stop();

      if (flags.output === 'json') {
        console.log(JSON.stringify(listing, null, 2));
        return;
      }
      console.log('');
      console.log(
        chalk.bold(
          `  ${backup.volumeName ?? 'volume'}:/${listing.path}${listing.isFile ? '' : '/'}`,
        ),
      );
      if (listing.entries.length === 0) {
        console.log(chalk.dim('  (empty)'));
      } else {
        const [, ...rows] = renderTable(
          ['MODE', 'SIZE', 'MODIFIED', 'NAME'],
          listing.entries.map(entryColumns),
        );
        for (const row of rows) console.log(`  ${row}`);
      }
      console.log('');
    } catch (error: any) {
      spinner.fail('Could not list the backup');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
