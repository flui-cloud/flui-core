import { Command } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../../lib/api-client';
import { ConfigStorage } from '../../../lib/config-storage';

interface GhcrPatStatus {
  configured: boolean;
  status?: string;
  expiresAt?: string | null;
  daysUntilExpiry?: number | null;
  lastRotatedAt?: string | null;
  lastVerifiedAt?: string | null;
  githubLogin?: string;
  scopes?: string[];
}

export default class IntegrationGhcrPatStatus extends Command {
  static readonly description =
    'Show the current state of the GHCR PAT used by Flui to pull container images from GHCR.';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    let status: GhcrPatStatus;
    try {
      status = await api.get<GhcrPatStatus>(
        '/repositories/github-app/packages-pat/status',
      );
    } catch (error: unknown) {
      this.error(
        `Failed to fetch GHCR PAT status: ${(error as Error).message}`,
        { exit: 1 },
      );
    }

    console.log('');
    if (!status.configured) {
      console.log(
        `  ${chalk.bold('Status:')} ${chalk.yellow('not configured')}`,
      );
      console.log('');
      console.log(
        chalk.dim(
          `  Run \`${chalk.cyan('flui integration ghcr-pat set')}\` to add one.`,
        ),
      );
      console.log('');
      return;
    }

    const statusColor =
      status.status === 'VALID'
        ? chalk.green
        : status.status === 'EXPIRING_SOON'
          ? chalk.yellow
          : chalk.red;

    console.log(
      `  ${chalk.bold('Status:')}    ${statusColor(status.status ?? 'unknown')}`,
    );
    if (status.githubLogin) {
      console.log(`  GitHub user: ${chalk.bold(status.githubLogin)}`);
    }
    if (status.scopes && status.scopes.length > 0) {
      console.log(`  Scopes:      ${status.scopes.join(', ')}`);
    }
    if (status.expiresAt) {
      const date = new Date(status.expiresAt).toISOString().slice(0, 10);
      const days = status.daysUntilExpiry;
      const suffix =
        days != null
          ? days < 0
            ? chalk.red(` (expired ${-days}d ago)`)
            : days <= 14
              ? chalk.yellow(` (${days}d left)`)
              : chalk.dim(` (${days}d left)`)
          : '';
      console.log(`  Expires:     ${date}${suffix}`);
    }
    if (status.lastRotatedAt) {
      console.log(
        `  Rotated:     ${new Date(status.lastRotatedAt).toISOString().slice(0, 10)}`,
      );
    }
    if (status.lastVerifiedAt) {
      console.log(
        `  Verified:    ${new Date(status.lastVerifiedAt).toISOString().slice(0, 10)}`,
      );
    }
    console.log('');
  }
}
