import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  CliAppService,
  BackupDestinationInput,
} from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { confirmPrompt } from '../../../lib/prompts';
import {
  VolumeBackupClient,
  resolveBackupId,
} from '../../../lib/volume-backup-client';

export default class AppBackupDelete extends Command {
  static readonly description =
    'Delete a volume backup of an application. With a backup id from `flui app backup list`, the kopia snapshot or archive is removed with its record. ' +
    'With --bucket and --endpoint, every object under an export key prefix written to a bucket passed by hand is removed.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app 3f2a91c0',
    '<%= config.bin %> <%= command.id %> my-app flui/<cluster>/<app>/20260510170000-abc123 -b my-bucket -e https://s3.fr-par.scw.cloud',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    exportId: Args.string({
      description:
        'Backup id (from `flui app backup list`), or with --bucket the export key prefix',
      required: true,
    }),
  };

  static readonly flags = {
    cluster: Flags.string({
      char: 'c',
      description: 'Cluster name or ID (default: auto-detect)',
    }),
    bucket: Flags.string({
      char: 'b',
      description: 'S3 bucket where a hand-passed export lives',
      dependsOn: ['endpoint'],
    }),
    endpoint: Flags.string({
      char: 'e',
      description: 'S3 endpoint URL of that bucket',
      dependsOn: ['bucket'],
    }),
    region: Flags.string({
      char: 'r',
      description: 'S3 region',
      default: 'auto',
    }),
    'access-key': Flags.string({
      description: 'S3 access key id (defaults to FLUI_S3_ACCESS_KEY env)',
      env: 'FLUI_S3_ACCESS_KEY',
    }),
    'secret-key': Flags.string({
      description: 'S3 secret access key (defaults to FLUI_S3_SECRET_KEY env)',
      env: 'FLUI_S3_SECRET_KEY',
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'Skip confirmation',
      aliases: ['force'],
      charAliases: ['f'],
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppBackupDelete);
    if (!flags.bucket || !flags.endpoint) {
      await this.deleteRecorded(args.name, args.exportId, flags);
      return;
    }
    if (!flags['access-key'] || !flags['secret-key']) {
      this.error(
        'S3 credentials missing. Pass --access-key/--secret-key or set FLUI_S3_ACCESS_KEY/FLUI_S3_SECRET_KEY.',
      );
    }
    if (!flags.yes) {
      const ok = await confirmPrompt(
        `Delete backup "${args.exportId}" from s3://${flags.bucket}?`,
      );
      if (!ok) {
        console.log(chalk.dim('  Aborted.'));
        return;
      }
    }
    const destination: BackupDestinationInput = {
      bucket: flags.bucket,
      endpoint: flags.endpoint,
      region: flags.region,
      accessKeyId: flags['access-key'],
      secretAccessKey: flags['secret-key'],
    };
    const spinner = ora(`Deleting backup ${args.exportId}...`).start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const service = await CliAppService.create(clusterId);
      const app = await service.getAppByName(args.name);
      await service.deleteAppBackup(app.id, args.exportId, destination);
      spinner.succeed(`Deleted backup ${args.exportId}`);
    } catch (error: any) {
      spinner.fail('Backup deletion failed');
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }

  private async deleteRecorded(
    appName: string,
    ref: string,
    flags: { cluster?: string; yes?: boolean },
  ): Promise<void> {
    const spinner = ora('Finding the backup...').start();
    try {
      const { id: clusterId } = await resolveClusterRef(flags.cluster);
      const app = await (
        await CliAppService.create(clusterId)
      ).getAppByName(appName);
      const client = VolumeBackupClient.create();
      const backup = resolveBackupId(await client.list(app.id), ref);
      spinner.stop();
      if (!flags.yes) {
        const ok = await confirmPrompt(
          `Delete ${backup.engine} backup ${backup.id.slice(0, 8)} of ${backup.volumeName ?? 'the volume'}? It cannot be restored afterwards.`,
        );
        if (!ok) {
          console.log(chalk.dim('  Aborted.'));
          return;
        }
      }
      const running = ora(
        `Deleting backup ${backup.id.slice(0, 8)}...`,
      ).start();
      await client.remove(app.id, backup.id);
      running.succeed(`Deleted backup ${backup.id.slice(0, 8)}`);
    } catch (error: any) {
      spinner.stop();
      const msg =
        error.response?.data?.message ?? error.message ?? String(error);
      console.log(chalk.red(`\n  Error: ${msg}\n`));
      this.exit(1);
    }
  }
}
