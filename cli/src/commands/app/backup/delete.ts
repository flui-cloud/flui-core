import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import {
  CliAppService,
  BackupDestinationInput,
} from '../../../lib/services/cli-app.service';
import { resolveClusterRef } from '../../../lib/resolve-cluster';
import { confirmPrompt } from '../../../lib/prompts';

export default class AppBackupDelete extends Command {
  static readonly description =
    'Delete an S3 backup of an application. Removes all objects under the export key prefix.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> my-app flui/<cluster>/<app>/20260510170000-abc123 -b my-bucket -e https://s3.fr-par.scw.cloud',
  ];

  static readonly args = {
    name: Args.string({
      description: 'Application name or slug',
      required: true,
    }),
    exportId: Args.string({
      description:
        'Export id (S3 key prefix) returned by `flui app backup create`',
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
      description: 'S3 bucket where the backup lives',
      required: true,
    }),
    endpoint: Flags.string({
      char: 'e',
      description: 'S3 endpoint URL',
      required: true,
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
    force: Flags.boolean({
      char: 'f',
      description: 'Skip confirmation',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(AppBackupDelete);
    if (!flags['access-key'] || !flags['secret-key']) {
      this.error(
        'S3 credentials missing. Pass --access-key/--secret-key or set FLUI_S3_ACCESS_KEY/FLUI_S3_SECRET_KEY.',
      );
    }
    if (!flags.force) {
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
}
