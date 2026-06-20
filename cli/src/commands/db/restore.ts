import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { createReadStream, existsSync } from 'node:fs';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { confirmPrompt } from '../../lib/prompts';

export default class DbRestore extends Command {
  static readonly description =
    'Restore a logical SQL dump into a Flui database (Postgres/MariaDB).\n' +
    'WARNING: this runs the dump against the live database and OVERWRITES existing data.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> <app-id> backup.sql',
    '<%= config.bin %> <%= command.id %> <app-id> backup.sql --yes',
  ];

  static readonly args = {
    app: Args.string({
      description: 'Database application id (see `flui app list`)',
      required: true,
    }),
    file: Args.string({
      description: 'Path to the SQL dump file to restore',
      required: true,
    }),
  };

  static readonly flags = {
    yes: Flags.boolean({
      description: 'Skip the confirmation prompt',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DbRestore);
    if (!existsSync(args.file)) {
      this.error(`File not found: ${args.file}`);
    }
    const cfg = new ConfigStorage();
    const apiKey = cfg.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.');
    }
    const api = new ApiClient({ baseUrl: cfg.getApiUrlOrThrow(), apiKey });

    if (!flags.yes) {
      const ok = await confirmPrompt(
        chalk.yellow(
          `Restore "${args.file}" into application ${args.app}? This OVERWRITES existing data.`,
        ),
        false,
      );
      if (!ok) {
        this.log('Aborted.');
        return;
      }
    }

    const spinner = ora('Restoring…').start();
    try {
      await api.postStream(
        `/applications/${args.app}/db-backup/restore?confirm=true`,
        createReadStream(args.file),
      );
      spinner.succeed('Restore complete.');
    } catch (e) {
      spinner.fail('Restore failed.');
      this.error(e instanceof Error ? e.message : String(e));
    }
  }
}
