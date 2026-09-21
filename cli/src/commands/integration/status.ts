import { Args, Command } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient, ApiError } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';

interface SetupStatus {
  configured: boolean;
  authMethod: 'pat' | 'github_app' | null;
  appSlug?: string;
}

interface HealthDetails {
  appSlug?: string;
  appId?: string | number;
  installationsCount?: number;
  note?: string;
  error?: string;
  message?: string;
  status?: number;
}

interface HealthResponse {
  ok: boolean;
  mode: 'pat' | 'github_app' | null;
  details: HealthDetails;
}

interface UserGithubStatus {
  connected: boolean;
  githubUsername?: string;
  scopes?: string;
  connectedAt?: string;
}

export default class IntegrationStatus extends Command {
  static readonly description =
    'Show the current GitHub integration status: configured mode, live health check, and (in PAT mode) your own connection state.';

  static readonly examples = ['<%= config.bin %> <%= command.id %> github'];

  static readonly args = {
    provider: Args.string({
      description: 'Integration provider (currently only `github`)',
      required: true,
      options: ['github'],
    }),
  };

  async run(): Promise<void> {
    const { args } = await this.parse(IntegrationStatus);
    if (args.provider !== 'github') {
      this.error(`Unknown provider "${args.provider}"`, { exit: 1 });
    }

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    const spinner = ora('Fetching GitHub integration status…').start();
    let status: SetupStatus | null = null;
    let health: HealthResponse | null = null;
    try {
      [status, health] = await Promise.all([
        api.get<SetupStatus>('/repositories/github/setup/status'),
        api
          .get<HealthResponse>('/repositories/github/setup/health')
          .catch((err: unknown) => {
            if (err instanceof ApiError && err.statusCode === 403) {
              return null;
            }
            throw err;
          }),
      ]);
      spinner.stop();
    } catch (error: unknown) {
      spinner.fail('Failed to fetch status');
      if (error instanceof ApiError) {
        console.log(chalk.red(`  ${error.statusCode}: ${error.message}`));
      } else {
        console.log(chalk.red(`  ${(error as Error).message}`));
      }
      this.exit(1);
    }

    console.log('');
    console.log(chalk.bold('  Instance configuration'));
    if (!status?.configured) {
      console.log(
        `    ${chalk.dim('Mode:')}          ${chalk.yellow('not configured')}`,
      );
      console.log('');
      console.log(
        chalk.dim(`  Run \`flui integration setup github\` to configure it.\n`),
      );
      return;
    }

    console.log(
      `    ${chalk.dim('Mode:')}          ${chalk.cyan(status.authMethod ?? '?')}`,
    );
    if (status.appSlug) {
      console.log(`    ${chalk.dim('App slug:')}      ${status.appSlug}`);
    }
    if (health) {
      const healthSummary = summariseHealth(health);
      console.log(`    ${chalk.dim('Health:')}        ${healthSummary}`);
    } else {
      console.log(
        `    ${chalk.dim('Health:')}        ${chalk.dim('(admin only)')}`,
      );
    }

    if (status.authMethod === 'pat') {
      let userStatus: UserGithubStatus | null = null;
      try {
        userStatus = await api.get<UserGithubStatus>(
          '/repositories/github/status',
        );
      } catch {
        userStatus = null;
      }
      console.log('');
      console.log(chalk.bold('  Your connection'));
      if (userStatus?.connected) {
        console.log(
          `    ${chalk.dim('Authenticated:')} @${userStatus.githubUsername}`,
        );
        if (userStatus.scopes) {
          console.log(
            `    ${chalk.dim('Scopes:')}        ${userStatus.scopes}`,
          );
        }
      } else {
        console.log(
          `    ${chalk.dim('Authenticated:')} ${chalk.yellow('not connected')}`,
        );
        console.log(
          chalk.dim(
            '    Run `flui integration setup github` (PAT branch) to connect.',
          ),
        );
      }
    }

    console.log('');
  }
}

function summariseHealth(health: HealthResponse): string {
  if (!health.ok) {
    const reason = health.details.error ?? 'unknown';
    return chalk.red(
      `✖ ${reason}${health.details.message ? ` — ${health.details.message}` : ''}`,
    );
  }
  if (health.mode === 'github_app') {
    const installCount = health.details.installationsCount ?? 0;
    return chalk.green(
      `✔ App auth ok — ${installCount} installation${installCount === 1 ? '' : 's'}`,
    );
  }
  if (health.mode === 'pat') {
    return chalk.green('✔ PAT mode enabled (per-user credentials)');
  }
  return chalk.dim('—');
}
