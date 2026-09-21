import { Args, Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import ora from 'ora';
import { ApiClient, ApiError } from '../../lib/api-client';
import { ConfigStorage } from '../../lib/config-storage';
import { confirmByTypingPrompt } from '../../lib/prompts';

interface SetupStatus {
  configured: boolean;
  authMethod: 'pat' | 'github_app' | null;
  appSlug?: string;
}

export default class IntegrationReset extends Command {
  static readonly description =
    'Remove the instance-wide GitHub integration (admin). Clears the stored config plus all per-user tokens and App installations. Users will need to reconnect afterwards.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %> github',
    '<%= config.bin %> <%= command.id %> github --yes',
  ];

  static readonly args = {
    provider: Args.string({
      description: 'Integration provider (currently only `github`)',
      required: true,
      options: ['github'],
    }),
  };

  static readonly flags = {
    yes: Flags.boolean({
      description: 'Skip the typed confirmation (for scripts / CI)',
      default: false,
    }),
  };

  async run(): Promise<void> {
    const { args, flags } = await this.parse(IntegrationReset);
    if (args.provider !== 'github') {
      this.error(`Unknown provider "${args.provider}"`, { exit: 1 });
    }

    const configStorage = new ConfigStorage();
    const apiUrl = configStorage.getApiUrlOrThrow();
    const apiKey = configStorage.getApiKeyOrThrow();
    const api = new ApiClient({ baseUrl: apiUrl, apiKey });

    let status: SetupStatus | null = null;
    try {
      status = await api.get<SetupStatus>('/repositories/github/setup/status');
    } catch (error: unknown) {
      this.printApiError(error);
      this.exit(1);
    }

    if (!status?.configured) {
      console.log('');
      console.log(
        chalk.dim('  GitHub integration is not configured — nothing to reset.'),
      );
      console.log('');
      return;
    }

    console.log('');
    console.log(chalk.bold('  This will remove:'));
    console.log(
      `    • Instance config (mode=${status.authMethod}${status.appSlug ? `, app=${status.appSlug}` : ''})`,
    );
    console.log('    • All per-user GitHub tokens stored by Flui');
    console.log('    • All recorded GitHub App installations');
    console.log('');
    console.log(
      chalk.yellow(
        '  Existing apps will keep deploying until their next event, but new repo syncs and webhooks will fail until the integration is reconfigured.',
      ),
    );
    console.log('');

    if (!flags.yes) {
      const confirmed = await confirmByTypingPrompt(
        `  Type ${chalk.bold('reset')} to confirm`,
        'reset',
      );
      if (!confirmed) {
        console.log(chalk.dim('\n  Cancelled.\n'));
        return;
      }
    }

    const spinner = ora('Resetting GitHub integration…').start();
    try {
      await api.delete('/repositories/github/setup');
      spinner.succeed('GitHub integration reset');
    } catch (error: unknown) {
      spinner.fail('Reset failed');
      this.printApiError(error);
      this.exit(1);
    }

    console.log('');
    console.log(
      chalk.dim(
        '  Next: `flui integration setup github` to configure a fresh integration.',
      ),
    );
    console.log('');
  }

  private printApiError(error: unknown): void {
    if (error instanceof ApiError) {
      console.log(chalk.red(`  ${error.statusCode}: ${error.message}`));
    } else {
      console.log(chalk.red(`  ${(error as Error).message}`));
    }
  }
}
