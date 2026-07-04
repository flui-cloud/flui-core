import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { confirmPrompt } from '../../lib/prompts';

interface RestoreJob {
  id: string;
  status: string;
  targetKind: string;
}

export default class DbPitrRestore extends Command {
  static readonly description =
    'Restore a Flui Postgres database as-of a point in time into a NEW install.\n' +
    'Non-destructive: the source is never touched — a fresh install is created and\n' +
    'recovered from the continuous backup (WAL/PITR). Connect to it with its own\n' +
    'Flui-managed credentials once it is running.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> <app-id> --name pg-restored',
    '<%= config.bin %> <%= command.id %> <app-id> --name pg-asof --at "2026-07-03T12:00:00Z"',
    '<%= config.bin %> <%= command.id %> <app-id> --name pg-dr --cluster <cluster-id>',
  ];

  static readonly args = {
    app: Args.string({
      description: 'Source database application id (see `flui app list`)',
      required: true,
    }),
  };

  static readonly flags = {
    name: Flags.string({
      description: 'Display name for the restored install',
      required: true,
    }),
    at: Flags.string({
      description:
        'ISO-8601 instant to recover to (e.g. 2026-07-03T12:00:00Z). Omit for latest.',
    }),
    cluster: Flags.string({
      description: 'Target cluster id (defaults to the source app cluster)',
    }),
    yes: Flags.boolean({
      description: 'Skip the confirmation prompt',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(DbPitrRestore);
    const cfg = new ConfigStorage();
    const apiKey = cfg.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.');
    }
    const api = new ApiClient({ baseUrl: cfg.getApiUrlOrThrow(), apiKey });

    const asOf = flags.at
      ? `as of ${chalk.cyan(flags.at)}`
      : chalk.cyan('latest');
    if (!flags.yes) {
      const ok = await confirmPrompt(
        `Restore database ${args.app} (${asOf}) into a new install "${flags.name}"?`,
        true,
      );
      if (!ok) {
        this.log('Aborted.');
        return;
      }
    }

    const spinner = ora('Creating restore job…').start();
    let job: RestoreJob;
    try {
      job = await api.post<RestoreJob>(
        `/applications/${args.app}/db-pitr/restore`,
        {
          name: flags.name,
          ...(flags.at ? { recoveryTargetTime: flags.at } : {}),
          ...(flags.cluster ? { clusterId: flags.cluster } : {}),
        },
      );
    } catch (e) {
      spinner.fail('Could not start the restore.');
      this.error(e instanceof Error ? e.message : String(e));
    }
    spinner.succeed(
      `Restore job ${chalk.cyan(job.id)} started (${job.status}). ` +
        `The new install boots in recovery mode; track it with \`flui app list\`.`,
    );
  }
}
