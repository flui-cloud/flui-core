import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface DbPitrStatus {
  applicationId: string;
  continuousBackupEnabled: boolean;
  policyId: string | null;
  cronSchedule: string | null;
  backupCount: number;
  window: { oldest: string | null; newest: string | null } | null;
  lastBackup: { engineRef: string | null; at: string } | null;
  latestArtifactId: string | null;
  sourceDestinationId: string | null;
}

export default class DbBackupStatus extends Command {
  static readonly description =
    'Show continuous-backup (PITR) status for a Flui Postgres database:\n' +
    'whether continuous backup is on, the recoverable window, and the last base backup.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> <app-id>',
    '<%= config.bin %> <%= command.id %> <app-id> --json',
  ];

  static readonly enableJsonFlag = true;

  static readonly args = {
    app: Args.string({
      description: 'Database application id (see `flui app list`)',
      required: true,
    }),
  };

  async run(): Promise<DbPitrStatus> {
    const { args } = await this.parse(DbBackupStatus);
    const cfg = new ConfigStorage();
    const apiKey = cfg.getApiKey();
    if (!apiKey) {
      this.error('Not logged in. Run `flui auth login` first.');
    }
    const api = new ApiClient({ baseUrl: cfg.getApiUrlOrThrow(), apiKey });

    let status: DbPitrStatus;
    try {
      status = await api.get<DbPitrStatus>(
        `/applications/${args.app}/db-pitr/status`,
      );
    } catch (e) {
      this.error(e instanceof Error ? e.message : String(e));
    }

    if (!this.jsonEnabled()) {
      const on = status.continuousBackupEnabled;
      this.log(
        `Continuous backup: ${on ? chalk.green('enabled') : chalk.yellow('disabled')}` +
          (status.cronSchedule
            ? chalk.gray(`  (base backup ${status.cronSchedule})`)
            : ''),
      );
      if (status.window) {
        this.log(
          `Recoverable window: ${chalk.cyan(status.window.oldest ?? '—')} ` +
            `→ ${chalk.cyan(status.window.newest ?? '—')} ${chalk.gray('(newest ≈ now with live WAL)')}`,
        );
      } else {
        this.log(
          chalk.gray(
            'Recoverable window: unavailable (database not reachable)',
          ),
        );
      }
      this.log(`Base backups: ${status.backupCount}`);
      if (status.lastBackup) {
        this.log(
          `Last backup: ${chalk.cyan(status.lastBackup.engineRef ?? '—')} ${chalk.gray(`at ${status.lastBackup.at}`)}`,
        );
      }
      if (!on) {
        this.log(
          chalk.gray(
            'Enable continuous backup with a database-class backup policy (`flui backup policy create`).',
          ),
        );
      } else {
        this.log(
          chalk.gray(
            `Restore as-of a point in time with \`flui db pitr-restore ${args.app}\`.`,
          ),
        );
      }
    }
    return status;
  }
}
