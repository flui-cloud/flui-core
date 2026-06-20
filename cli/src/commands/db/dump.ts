import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface DbBackupInfo {
  engine: string;
  database: string | null;
  format: 'sql' | 'rdb' | null;
  supported: boolean;
  restoreSupported: boolean;
  reason: string | null;
  suggestedFilename: string;
}

interface DbBackupS3Result {
  destinationId: string;
  bucket: string;
  key: string;
}

export default class DbDump extends Command {
  static readonly description =
    'Download a logical SQL dump of a Flui database (Postgres/MariaDB).\n' +
    'The dump is produced server-side with the engine native tool and streamed to a file.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> <app-id>',
    '<%= config.bin %> <%= command.id %> <app-id> -o backup.sql',
    '<%= config.bin %> <%= command.id %> <app-id> --s3-destination <destination-id>',
  ];

  static readonly args = {
    app: Args.string({
      description: 'Database application id (see `flui app list`)',
      required: true,
    }),
  };

  static readonly flags = {
    output: Flags.string({
      char: 'o',
      description: 'Write the dump to this file (default: <db>-<date>.sql)',
    }),
    's3-destination': Flags.string({
      description:
        'Store the dump in this backup destination (S3) instead of downloading it. ' +
        'See `flui backup destination list` for ids.',
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DbDump);
    const cfg = new ConfigStorage();
    const apiKey = cfg.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.');
    }
    const api = new ApiClient({ baseUrl: cfg.getApiUrlOrThrow(), apiKey });

    const spinner = ora('Preparing dump…').start();
    let info: DbBackupInfo;
    try {
      info = await api.get<DbBackupInfo>(
        `/applications/${args.app}/db-backup/info`,
      );
    } catch (e) {
      spinner.fail('Could not reach the database.');
      this.error(e instanceof Error ? e.message : String(e));
    }
    if (!info.supported) {
      spinner.fail(
        info.reason ?? 'Logical backup not supported for this engine.',
      );
      return;
    }

    const destination = flags['s3-destination'];
    if (destination) {
      spinner.text = `Dumping ${info.engine} database "${info.database}" → S3…`;
      try {
        const result = await api.get<DbBackupS3Result>(
          `/applications/${args.app}/db-backup/dump?destinationId=${encodeURIComponent(destination)}`,
        );
        spinner.succeed(
          `Dump stored in ${chalk.cyan(result.bucket + '/' + result.key)}`,
        );
      } catch (e) {
        spinner.fail('Dump to S3 failed.');
        this.error(e instanceof Error ? e.message : String(e));
      }
      return;
    }

    const out = flags.output ?? info.suggestedFilename;
    spinner.text = `Dumping ${info.engine} database "${info.database}" → ${out}…`;
    try {
      const stream = await api.getStream(
        `/applications/${args.app}/db-backup/dump`,
      );
      await pipeline(stream, createWriteStream(out));
      spinner.succeed(`Dump written to ${chalk.cyan(out)}`);
    } catch (e) {
      spinner.fail('Dump failed.');
      this.error(e instanceof Error ? e.message : String(e));
    }
  }
}
