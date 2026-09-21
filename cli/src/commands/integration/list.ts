import { Command } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface GitHubStatus {
  connected: boolean;
  githubUsername?: string;
  scopes?: string;
  connectedAt?: string;
}

interface GhcrPatStatus {
  configured: boolean;
  status?: string;
  expiresAt?: string | null;
  daysUntilExpiry?: number | null;
}

export default class IntegrationList extends Command {
  static readonly description =
    'List third-party integrations configured for your account and show whether each is connected.';

  static readonly examples = ['<%= config.bin %> <%= command.id %>'];

  async run(): Promise<void> {
    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    let github: GitHubStatus;
    try {
      github = await api.get<GitHubStatus>('/repositories/github/status');
    } catch (error: unknown) {
      this.error(`Could not fetch GitHub status: ${(error as Error).message}`, {
        exit: 1,
      });
    }

    let ghcrPat: GhcrPatStatus | null = null;
    try {
      ghcrPat = await api.get<GhcrPatStatus>(
        '/repositories/github-app/packages-pat/status',
      );
    } catch {
      /* empty */
    }

    console.log('');
    console.log(`  ${chalk.bold('PROVIDER')}      ${chalk.bold('STATUS')}`);
    console.log(`  ${'─'.repeat(12)}  ${'─'.repeat(60)}`);
    console.log(`  github        ${this.renderGithubStatus(github)}`);
    console.log(`  ghcr-pat      ${this.renderGhcrPatStatus(ghcrPat)}`);
    console.log('');
  }

  private renderGithubStatus(github: GitHubStatus): string {
    if (!github.connected) {
      return `${chalk.yellow('not connected')} — run \`flui integration connect github\``;
    }
    const since = github.connectedAt
      ? new Date(github.connectedAt).toISOString().slice(0, 10)
      : 'unknown';
    return `${chalk.green('connected')} as ${chalk.bold(github.githubUsername ?? '?')} (since ${since})`;
  }

  private renderGhcrPatStatus(ghcrPat: GhcrPatStatus | null): string {
    if (!ghcrPat?.configured) {
      return `${chalk.yellow('not configured')} — required for deploys, run \`flui integration ghcr-pat set\``;
    }
    const days = ghcrPat.daysUntilExpiry;
    if (days == null) return chalk.green('valid');
    if (days < 0) return chalk.red(`expired ${-days}d ago`);
    if (days <= 14) return chalk.yellow(`expires in ${days}d`);
    return chalk.green(`valid (expires in ${days}d)`);
  }
}
