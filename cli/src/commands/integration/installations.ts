import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface InstallationRow {
  installationId: number;
  accountLogin: string;
  accountType: 'User' | 'Organization';
  repositorySelection: string;
  suspendedAt?: string | null;
  suspended?: boolean;
  createdAt: string;
}

export default class IntegrationInstallations extends Command {
  static readonly description =
    'List all GitHub App installations tracked by Flui. Requires admin privileges. Use the `installationId` shown here with `flui integration remove-installation` to delete a stale or wrong record. With --mine, list only the installations your own GitHub account reaches, which needs no admin privileges.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --mine',
  ];

  static readonly flags = {
    mine: Flags.boolean({
      description:
        'Only the installations your own GitHub account reaches (no admin privileges needed)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(IntegrationInstallations);
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    let rows: InstallationRow[];
    try {
      rows = await api.get<InstallationRow[]>(
        flags.mine
          ? '/repositories/github-app/installations/mine'
          : '/repositories/github-app/installations',
      );
    } catch (error: unknown) {
      this.error(`Failed to list installations: ${(error as Error).message}`, {
        exit: 1,
      });
    }

    if (!rows || rows.length === 0) {
      console.log(chalk.dim('\n  No GitHub App installations tracked.\n'));
      return;
    }

    console.log('');
    console.log(
      `  ${chalk.bold('INSTALLATION_ID')}  ${chalk.bold('ACCOUNT')}  ${chalk.bold('TYPE')}  ${chalk.bold('STATUS')}  ${chalk.bold('CREATED')}`,
    );
    console.log(`  ${'─'.repeat(80)}`);
    for (const r of rows) {
      const created = new Date(r.createdAt).toISOString().slice(0, 10);
      const status =
        (r.suspended ?? !!r.suspendedAt)
          ? chalk.yellow('suspended')
          : chalk.green('active');
      console.log(
        `  ${String(r.installationId).padEnd(15)}  ${r.accountLogin.padEnd(20)}  ${r.accountType.padEnd(12)}  ${status}  ${created}`,
      );
    }
    console.log('');
  }
}
